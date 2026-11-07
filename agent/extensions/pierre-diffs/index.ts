/**
 * Pierre Diffs Extension
 *
 * Renders `edit` and `write` results in the visual language of @pierre/diffs
 * (https://diffs.com): stacked or split layout, bars/classic/no change
 * indicators, tinted or text-only change colours, line number gutters, word
 * level intra-line emphasis and hunk separators for skipped context.
 *
 * The library renders HTML into shadow DOM, which a terminal cannot do, so this
 * is a native port of its layout and option model rather than a wrapper.
 *
 * Commands:
 *   /diffs  -> settings list (layout, indicators, word diff, wrapping, …)
 *
 * State persisted in extensionSettings["pierre-diffs"] (settings.json).
 *
 * Modules:
 *   options.ts  option schema (mirrors @pierre/diffs) + typed config
 *   patch.ts    unified diff parser (both line numbers)
 *   words.ts    intra-line LCS ranges
 *   ansi.ts     background overlay over already-highlighted text
 *   render.ts   layout + painting, dependency free
 */

import {
  createEditToolDefinition,
  createWriteToolDefinition,
  getLanguageFromPath,
  getSettingsListTheme,
  highlightCode,
  type EditToolDetails,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
  backgroundAnsi,
  type Color,
  getCapabilities,
  mixColors,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getExtSetting, setExtSetting } from "../../utils/extension-settings/index.js";
import {
  OPTIONS,
  configSignature,
  normalizeOptions,
  parseValue,
  resolveConfig,
  valuesFor,
  type DiffConfig,
  type DiffOptions,
  type OptionKey,
} from "./options.ts";
import { addedFilePatch, parsePatch, type ParsedPatch } from "./patch.ts";
import { renderPatch, type Palette, type Renderer } from "./render.ts";
import { createSnapshotter } from "./snapshot.ts";

const SETTINGS_KEY = "pierre-diffs";
/** `write` previews a whole file, not a diff: that is the only thing collapsed. */
const WRITE_PREVIEW_LINES = 28;
/** Hard ceiling for a diff. Pi's own edit renderer has none; this bounds the frame. */
const DIFF_LINES = 1200;
/** Writes materialise at most this many rows, so the render cap is the only limit. */
const WRITE_ROW_LIMIT = DIFF_LINES;
const CACHE_LIMIT = 64;
/** Custom entry type for a diff of files changed by a tool the extension does not own. */
const DIFF_ENTRY = "pierre-diff";

interface DiffEntryData {
  patch: string;
  files: number;
  additions: number;
  deletions: number;
}

/**
 * Tools that cannot change files. Everything else is snapshotted, because a
 * shell command, a formatter or an MCP tool can rewrite the worktree.
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "ctx_read",
  "ctx_grep",
  "ctx_find",
  "ctx_ls",
  "ctx_glob",
  "ctx_search",
  "ctx_compose",
  "ctx_expand",
  "ctx_tree",
  "ctx_callgraph",
  "ctx_discover_tools",
  "ctx_session",
  "lean_ctx",
  "ollama_web_search",
  "ollama_web_fetch",
  "todo",
  "notify",
]);
/** Rendered inside their own tool row, so they must not also append an entry. */
const INLINE_DIFF_TOOLS = new Set(["edit", "write"]);

/** Parsed patch plus the lines rendered for one width/option set. */
interface RenderCache {
  source: string;
  model: ParsedPatch;
  configKey: string;
  paletteId: number;
  language: string | undefined;
  maxLines: number;
  width: number;
  fileHeader: RenderOptions["fileHeader"];
  lines: string[];
}

interface PaletteState {
  id: number;
  palette: Palette<Color>;
}

const renderCache = new Map<string, RenderCache>();
const paletteCache = new WeakMap<Theme, PaletteState>();
let nextPaletteId = 1;
let options: DiffOptions = normalizeOptions(getExtSetting(SETTINGS_KEY, undefined));
let viewCache: { source: DiffOptions; config: DiffConfig; configKey: string } | undefined;

/** Resolved config + its cache key, recomputed only when the options object changes. */
const currentView = (): { config: DiffConfig; configKey: string } => {
  if (viewCache?.source !== options) {
    const config = resolveConfig(options);
    viewCache = { source: options, config, configKey: configSignature(config) };
  }
  return viewCache;
};

// ── Palette ──────────────────────────────────────────────────────────────

const paletteFor = (theme: Theme): PaletteState => {
  const cached = paletteCache.get(theme);
  if (cached) return cached;

  const base = theme.colors.toolSuccessBg;
  const state: PaletteState = {
    id: nextPaletteId++,
    palette: {
      added: mixColors(base, theme.colors.toolDiffAdded, 0.18),
      removed: mixColors(base, theme.colors.toolDiffRemoved, 0.18),
      addedEmphasis: mixColors(base, theme.colors.toolDiffAdded, 0.45),
      removedEmphasis: mixColors(base, theme.colors.toolDiffRemoved, 0.45),
    },
  };
  paletteCache.set(theme, state);
  return state;
};

// ── Highlighting ─────────────────────────────────────────────────────────

const HIGHLIGHT_CACHE_LIMIT = 1500;
/** Minified/generated lines cost ~0.4ms each to tokenise; pierre caps them too. */
const HIGHLIGHT_MAX_LINE = 1000;
const highlightCache = new Map<string, string>();

/**
 * `highlightCode` runs highlight.js per line (~25µs). Caching by theme, language
 * and text keeps a resize or an expand toggle from re-tokenising every row.
 */
const highlightLine = (text: string, language: string, themeId: number): string => {
  if (text.length > HIGHLIGHT_MAX_LINE) return text;

  const key = `${themeId}\u0000${language}\u0000${text}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;

  let line = text;
  try {
    line = highlightCode(text, language)[0] ?? text;
  } catch {
    // Unsupported language or uninitialised theme: keep the plain text.
  }

  if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next();
    if (!oldest.done) highlightCache.delete(oldest.value);
  }
  highlightCache.set(key, line);
  return line;
};

// ── Renderer ─────────────────────────────────────────────────────────────

type FgToken = Parameters<Theme["fg"]>[0];

const createRenderer = (theme: Theme, language: string | undefined, themeId: number): Renderer<Color> => {
  const mode = getCapabilities().trueColor ? "truecolor" : "256";
  return {
    fg: (token, text) => theme.fg(token as FgToken, text),
    bg: (color) => (color === undefined ? "" : backgroundAnsi(color, mode)),
    width: (text) => visibleWidth(text),
    wrap: (text, width) => {
      if (text.length === 0) return [""];
      const wrapped = wrapTextWithAnsi(text, width);
      return wrapped.length > 0 ? wrapped : [""];
    },
    // Ellipsis by default: a clipped line must not look like a complete one.
    truncate: (text, width) => truncateToWidth(text, width),
    highlight: (text) =>
      !language || text.trim().length === 0 ? text : highlightLine(text, language, themeId),
  };
};

// ── Cached model + lines ─────────────────────────────────────────────────

/** Parse once per tool call; later renders reuse the model (keyed by patch text). */
const modelFor = (
  toolCallId: string,
  source: string,
  build: (source: string) => ParsedPatch,
): ParsedPatch => {
  const cached = renderCache.get(toolCallId);
  if (cached && cached.source === source) return cached.model;

  const model = build(source);
  if (!cached && renderCache.size >= CACHE_LIMIT) {
    const oldest = renderCache.keys().next();
    if (!oldest.done) renderCache.delete(oldest.value);
  }
  renderCache.set(toolCallId, {
    source,
    model,
    configKey: "",
    paletteId: 0,
    language: undefined,
    maxLines: 0,
    width: -1,
    fileHeader: undefined,
    lines: [],
  });
  return model;
};

/** Everything `linesFor` needs beyond the model, the width and the config. */
interface RenderOptions {
  note?: string;
  fileHeader?: (file: string) => string;
}

/**
 * Render once per (width, options, theme, language, cap); every later frame is a
 * cache hit. Called from `Component.render`, which pi runs on every TUI frame,
 * so this path avoids allocating or joining strings.
 */
const linesFor = (
  toolCallId: string,
  model: ParsedPatch,
  view: { config: DiffConfig; configKey: string },
  theme: Theme,
  language: string | undefined,
  width: number,
  maxLines: number,
  options: RenderOptions,
): string[] => {
  const palettes = paletteFor(theme);
  const cached = renderCache.get(toolCallId);
  if (
    cached &&
    cached.model === model &&
    cached.configKey === view.configKey &&
    cached.paletteId === palettes.id &&
    cached.language === language &&
    cached.maxLines === maxLines &&
    cached.width === width &&
    cached.fileHeader === options.fileHeader
  ) {
    return cached.lines;
  }

  const lines = renderPatch(model, view.config, createRenderer(theme, language, palettes.id), palettes.palette, width, {
    maxLines,
    truncatedNote: options.note,
    fileHeader: options.fileHeader,
  });
  renderCache.set(toolCallId, {
    source: cached?.source ?? "",
    model,
    configKey: view.configKey,
    paletteId: palettes.id,
    language,
    maxLines,
    width,
    fileHeader: options.fileHeader,
    lines,
  });
  return lines;
};

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Lazily rendered tool-result component. The render cache is keyed by width,
 * options, theme and language, so there is nothing for `invalidate` to drop.
 */
const diffComponent = (build: (width: number) => string[]): { render(width: number): string[]; invalidate(): void } => ({
  render: build,
  invalidate: (): void => {},
});

/** Fallback rendering (pierre renderer disabled): plain coloured patch lines. */
const plainDiff = (diff: string, theme: Theme): string =>
  diff
    .split("\n")
    .map((line) =>
      line.startsWith("+")
        ? theme.fg("toolDiffAdded", line)
        : line.startsWith("-")
          ? theme.fg("toolDiffRemoved", line)
          : theme.fg("toolDiffContext", line),
    )
    .join("\n");

const HIDDEN = "\u22ef";

/**
 * Line shown in place of what did not fit. Collapsed means the rest is one key
 * away, so the note says how to get it; expanded means the ceiling was hit and
 * the patch really is cut.
 */
const truncatedNote = (expanded: boolean, context: { keyHint(key: string, hint: string): string }): string =>
  expanded ? `${HIDDEN} diff truncated` : `${HIDDEN} more diff lines \u00b7 ${context.keyHint("app.tools.expand", "expand")}`;

let lineCount: { content: string; lines: number } | undefined;

/**
 * Line count without materialising a line array: same semantics as
 * `addedFilePatch` (a trailing newline does not start another line).
 */
const addedFileLines = (content: string): number => {
  if (lineCount?.content === content) return lineCount.lines;

  let breaks = 0;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
    breaks++;
  }
  const lines = content.length === 0 ? 0 : breaks + (content.endsWith("\n") ? 0 : 1);
  lineCount = { content, lines };
  return lines;
};

/** First line of a textual tool result, or `fallback` when there is none. */
const resultText = (content: { type: string; text?: string } | undefined, fallback: string): string =>
  content?.type === "text" && content.text ? content.text.split("\n")[0] : fallback;

/**
 * One language for a whole block only when every file in it agrees: a diff that
 * spans `README.md` and `index.ts` has no single palette, and guessing one would
 * colour half the block wrong.
 */
const sharedLanguage = (patch: ParsedPatch): string | undefined => {
  let shared: string | undefined;
  for (const hunk of patch.hunks) {
    if (hunk.file === undefined) return undefined;
    const language = getLanguageFromPath(hunk.file);
    if (language === undefined) return undefined;
    if (shared === undefined) shared = language;
    else if (shared !== language) return undefined;
  }
  return shared;
};

// ── Extension entry ───────────────────────────────────────────────────────

export default function pierreDiffs(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const { renderShell: _editShell, ...editBase } = createEditToolDefinition(cwd);
  const { renderShell: _writeShell, ...writeBase } = createWriteToolDefinition(cwd);

  pi.on("session_start", () => {
    options = normalizeOptions(getExtSetting(SETTINGS_KEY, undefined));
  });

  // ── edit ────────────────────────────────────────────────────────────────
  pi.registerTool({
    ...editBase,

    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", args.path), 0, 0);
    },

    renderResult(result, { expanded }, theme, context) {
      const details = result.details as EditToolDetails | undefined;
      if (context.isError) {
        return new Text(theme.fg("error", resultText(result.content[0], "edit failed")), 0, 0);
      }

      const patch = details?.patch;
      if (!patch) {
        return new Text(
          details?.diff ? plainDiff(details.diff, theme) : theme.fg("success", "Applied"),
          0,
          0,
        );
      }

      const view = currentView();
      if (!view.config.enabled) return new Text(plainDiff(details?.diff ?? patch, theme), 0, 0);

      const language = getLanguageFromPath(context.args.path);
      return diffComponent((width) => {
        const model = modelFor(context.toolCallId, patch, parsePatch);
        return linesFor(
          context.toolCallId,
          model,
          view,
          theme,
          language,
          width,
          DIFF_LINES,
          { note: truncatedNote(expanded, context) },
        );
      });
    },
  });

  // ── write ───────────────────────────────────────────────────────────────
  pi.registerTool({
    ...writeBase,

    renderCall(args, theme) {
      const lines = addedFileLines(args.content);
      return new Text(
        theme.fg("toolTitle", theme.bold("write ")) +
          theme.fg("accent", args.path) +
          theme.fg("dim", ` (${lines} lines)`),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", resultText(result.content[0], "write failed")), 0, 0);
      }

      const view = currentView();
      if (!view.config.enabled) return new Text(theme.fg("success", "Written"), 0, 0);

      const source = context.args.content;
      const language = getLanguageFromPath(context.args.path);
      const maxLines = expanded ? DIFF_LINES : WRITE_PREVIEW_LINES;
      const note = truncatedNote(expanded, context);

      return diffComponent((width) => {
        const model = modelFor(context.toolCallId, source, (text) => addedFilePatch(text, WRITE_ROW_LIMIT));
        return linesFor(context.toolCallId, model, view, theme, language, width, maxLines, { note });
      });
    },
  });

  // ── diffs for tools the extension does not own ──────────────────────────
  // A tool can rewrite the worktree without going through edit/write: python
  // heredocs, sed, formatters, MCP tools. The worktree is snapshotted around
  // every such call and the result becomes its own block in the transcript, so
  // the change is visible wherever it came from.
  const snapshots = createSnapshotter((command, args, execOptions) => pi.exec(command, args, execOptions));

  const watched = (event: { toolName: string; parentToolCallId?: string }): boolean =>
    options.toolDiffs && !event.parentToolCallId && !READ_ONLY_TOOLS.has(event.toolName);

  pi.on("tool_call", async (event, ctx) => {
    if (!watched(event)) return;
    await snapshots.prime(ctx.cwd, ctx.signal);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!watched(event)) return;
    const patch = await snapshots.advance(ctx.cwd, ctx.signal);
    // edit/write already draw their patch inside the tool row.
    if (!patch || INLINE_DIFF_TOOLS.has(event.toolName)) return;

    const parsed = parsePatch(patch);
    if (parsed.hunks.length === 0) return; // binary-only change: nothing to draw

    const named = new Set(parsed.hunks.map((hunk) => hunk.file).filter((file) => file !== undefined));
    pi.appendEntry<DiffEntryData>(DIFF_ENTRY, {
      patch,
      files: named.size || 1,
      additions: parsed.additions,
      deletions: parsed.deletions,
    });
  });

  pi.on("session_shutdown", async () => {
    await snapshots.dispose();
  });

  pi.registerEntryRenderer<DiffEntryData>(DIFF_ENTRY, (entry, { expanded, keyHint }, theme) => {
    const data = entry.data;
    if (!data?.patch) return new Text("", 0, 0);

    const view = currentView();
    if (!view.config.enabled) return new Text(plainDiff(data.patch, theme), 0, 0);

    const cacheKey = `entry:${entry.id}`;
    const model = modelFor(cacheKey, data.patch, parsePatch);
    const summary = theme.fg(
      "dim",
      `${data.files} ${data.files === 1 ? "file" : "files"} · +${data.additions} -${data.deletions}`,
    );
    // Syntax colours only when the block is one language all the way through.
    const language = sharedLanguage(model);
    const fileHeader = (file: string): string => theme.fg("accent", theme.bold(file));

    return diffComponent((width) => {
      const options = { note: truncatedNote(expanded, { keyHint }), fileHeader };
      return [summary, ...linesFor(cacheKey, model, view, theme, language, width, DIFF_LINES, options)];
    });
  });

  // ── /diffs ───────────────────────────────────────────────────────────────
  pi.registerCommand("diffs", {
    description: "Diff rendering options: layout, indicators, word diff, wrapping, …",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/diffs requires interactive mode", "error");
        return;
      }

      let dirty = false;
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const items: SettingItem[] = OPTIONS.map((option) => ({
          id: option.key,
          label: option.label,
          currentValue: String(options[option.key]),
          values: [...valuesFor(option.key)],
          description: option.description,
        }));

        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("Diff rendering")), 0, 0));
        container.addChild(
          new Text(theme.fg("dim", "enter toggles · esc closes · applies to new renders"), 0, 0),
        );

        const list = new SettingsList(
          items,
          Math.min(items.length + 3, 16),
          getSettingsListTheme(),
          (id, value) => {
            const next = normalizeOptions({ ...options, [id]: parseValue(id as OptionKey, value) });
            // Changes made while the watcher was off are not this call's diff.
            if (!options.toolDiffs && next.toolDiffs) void snapshots.reset();
            options = next;
            setExtSetting(SETTINGS_KEY, options);
            dirty = true;
            tui.requestRender();
          },
          () => done(),
        );
        container.addChild(list);

        return {
          capturesViewportInput: list.capturesViewportInput,
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput?.(data);
            tui.requestRender();
          },
        };
      });

      ctx.ui.notify(dirty ? "Diff options saved" : "Diff options unchanged", "info");
    },
  });
}
