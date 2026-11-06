/**
 * Option model for the pierre diffs renderer.
 *
 * Keys and values mirror `@pierre/diffs` (`BaseCodeOptions` / `BaseDiffOptions`)
 * so the terminal renderer speaks the same vocabulary as the web library:
 *
 *   diffStyle, diffIndicators, lineDiffType, overflow, hunkSeparators,
 *   disableLineNumbers, disableBackground.
 *
 * The two "disable*" flags are stored positively here (`lineNumbers`,
 * `backgrounds`) because a settings entry reads better without a double
 * negative. Booleans are stored as JSON booleans in settings.json.
 */

interface BaseSpec {
  key: string;
  label: string;
  description: string;
}

/** One settings entry: either a boolean toggle or a choice between values. */
export type OptionSpec = BaseSpec &
  ({ type: "boolean"; fallback: boolean } | { type: "choice"; values: readonly string[]; fallback: string });

/** Single source of truth for defaults, validation and the `/diffs` list. */
export const OPTIONS = [
  {
    key: "enabled",
    type: "boolean",
    label: "Renderer",
    fallback: true,
    description: "Render edit/write diffs in pierre style (false = plain patch)",
  },
  {
    key: "diffStyle",
    type: "choice",
    label: "Layout",
    values: ["unified", "split"],
    fallback: "unified",
    description: "Stacked changes or side-by-side columns",
  },
  {
    key: "diffIndicators",
    type: "choice",
    label: "Indicators",
    values: ["bars", "classic", "none"],
    fallback: "bars",
    description: "Change markers: vertical bars, +/-, or nothing",
  },
  {
    key: "lineDiffType",
    type: "choice",
    label: "Word diff",
    values: ["word-alt", "word", "word-line", "char", "none"],
    fallback: "word-alt",
    description: "Intra-line emphasis for paired changes",
  },
  {
    key: "overflow",
    type: "choice",
    label: "Long lines",
    values: ["wrap", "scroll"],
    fallback: "wrap",
    description: "Wrap long lines or clip them at the column edge",
  },
  {
    key: "hunkSeparators",
    type: "choice",
    label: "Hunk separators",
    values: ["line-info", "line-info-basic", "simple", "metadata", "none"],
    fallback: "line-info",
    description: "How skipped unchanged lines between hunks are shown",
  },
  {
    key: "lineNumbers",
    type: "boolean",
    label: "Line numbers",
    fallback: true,
    description: "Show the line number gutters",
  },
  {
    key: "backgrounds",
    type: "boolean",
    label: "Backgrounds",
    fallback: true,
    description: "Tint added/removed lines with their change color",
  },
  {
    key: "syntaxHighlight",
    type: "boolean",
    label: "Syntax colors",
    fallback: true,
    description: "Highlight code with the active theme palette",
  },
] as const satisfies readonly OptionSpec[];

type Specs = (typeof OPTIONS)[number];
export type OptionKey = Specs["key"];

/** Booleans widen to `boolean`; choices widen to their value union. */
type ValueOf<S extends Specs> = S extends { values: readonly (infer Value)[] } ? Value : boolean;

export type DiffOptions = { [S in Specs as S["key"]]: ValueOf<S> };
export type DiffStyle = DiffOptions["diffStyle"];
export type DiffIndicators = DiffOptions["diffIndicators"];
export type LineDiffType = DiffOptions["lineDiffType"];
export type HunkSeparators = DiffOptions["hunkSeparators"];

export const DEFAULT_OPTIONS: DiffOptions = Object.fromEntries(
  OPTIONS.map((option) => [option.key, option.fallback]),
) as DiffOptions;

const specOf = (key: OptionKey): Specs => OPTIONS.find((option) => option.key === key) ?? OPTIONS[0];

/** Coerce stored settings into a complete, valid option set (drops unknown keys). */
export const normalizeOptions = (raw: unknown): DiffOptions => {
  const source = (raw ?? {}) as Record<string, unknown>;
  const result = { ...DEFAULT_OPTIONS } as Record<string, unknown>;

  for (const option of OPTIONS) {
    const value = source[option.key];
    if ("values" in option) {
      if (typeof value === "string" && option.values.includes(value as never)) result[option.key] = value;
    } else if (typeof value === "boolean") {
      result[option.key] = value;
    }
  }

  return result as DiffOptions;
};

/** String form used by the settings list, where every entry is a choice. */
export const valuesFor = (key: OptionKey): readonly string[] => {
  const spec = specOf(key);
  return "values" in spec ? spec.values : ["true", "false"];
};

/** Parse a settings-list value back into the stored type. */
export const parseValue = (key: OptionKey, raw: string): unknown => {
  const spec = specOf(key);
  return "values" in spec ? raw : raw === "true";
};

export interface DiffConfig {
  enabled: boolean;
  style: DiffStyle;
  indicators: DiffIndicators;
  lineDiff: LineDiffType;
  wrap: boolean;
  separators: HunkSeparators;
  lineNumbers: boolean;
  background: boolean;
  syntax: boolean;
}

/** Resolve validated settings into the typed config the renderer consumes. */
export const resolveConfig = (options: DiffOptions): DiffConfig => ({
  enabled: options.enabled,
  style: options.diffStyle,
  indicators: options.diffIndicators,
  lineDiff: options.lineDiffType,
  wrap: options.overflow === "wrap",
  separators: options.hunkSeparators,
  lineNumbers: options.lineNumbers,
  background: options.backgrounds,
  syntax: options.syntaxHighlight,
});

/** Stable signature used to invalidate cached renders when options change. */
export const configSignature = (config: DiffConfig): string =>
  [
    config.style,
    config.indicators,
    config.lineDiff,
    config.wrap ? "wrap" : "scroll",
    config.separators,
    config.lineNumbers ? "num" : "nonum",
    config.background ? "bg" : "nobg",
    config.syntax ? "syntax" : "plain",
  ].join("|");
