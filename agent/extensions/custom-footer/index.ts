/**
 * custom-footer — custom TUI status bar with real-time session stats.
 *
 * Replaces the default footer on session start with the model and thinking level,
 * token usage and context window %, elapsed time, cwd, git branch, throughput, and
 * the duration of the last query.
 *
 * Formatting, aggregation, and segment rendering live in `./format` (pure, unit-tested).
 */
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
  accumulateUsage,
  collectTotals,
  formatElapsed,
  outputTokens,
  renderModel,
  renderTokenStats,
  resolveModel,
  shortenCwd,
  type ModelRef,
  type UsageTotals,
} from "./format.js";

const RENDER_INTERVAL_MS = 30_000;

// ── State ──────────────────────────────────────────────────────────────

type TuiRef = { requestRender(): void };

type FooterHandle = {
  tui: TuiRef;
  data: ReadonlyFooterDataProvider;
  dispose(): void;
};

type FooterState = {
  sessionStart: number;
  usageTotals: UsageTotals;
  model: ModelRef | null;
  cwd: string;
  agentStartMs: number;
  lastTps: number;
  lastQueryMs: number;
  footer: FooterHandle | null;
};

const state: FooterState = {
  sessionStart: Date.now(),
  usageTotals: { input: 0, output: 0 },
  model: null,
  cwd: "",
  agentStartMs: 0,
  lastTps: 0,
  lastQueryMs: 0,
  footer: null,
};

const requestRender = (): void => state.footer?.tui.requestRender();

const resetTimings = (): void => {
  state.sessionStart = Date.now();
  state.agentStartMs = 0;
  state.lastTps = 0;
  state.lastQueryMs = 0;
};

/** Dispose the active footer (idempotent) and drop the stored handle. */
const disposeFooter = (): void => {
  const footer = state.footer;
  state.footer = null;
  footer?.dispose();
};

// ── Footer ─────────────────────────────────────────────────────────────

const contextUsagePercent = (ctx: ExtensionContext): number => {
  try {
    return ctx.getContextUsage()?.percent ?? 0;
  } catch {
    return 0;
  }
};

const installFooter = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
  if (ctx.mode !== "tui") return;

  state.cwd = ctx.cwd;
  state.model = (ctx.model as ModelRef | null) ?? null;
  state.usageTotals = collectTotals(ctx);

  ctx.ui.setFooter((tui, theme, data) => {
    const unsubscribe = data.onBranchChange(() => tui.requestRender());
    const timer = setInterval(() => tui.requestRender(), RENDER_INTERVAL_MS);

    const dispose = (): void => {
      clearInterval(timer);
      unsubscribe();
      if (state.footer?.tui === tui) state.footer = null;
    };
    state.footer = { tui, data, dispose };

    return {
      dispose,
      invalidate() {},
      render(width: number): string[] {
        const model = resolveModel(state.model, ctx.model as ModelRef | null);
        const thinking = state.footer ? pi.getThinkingLevel() : "off";
        const segments = [
          renderModel(theme, model, thinking),
          renderTokenStats(theme, state.usageTotals, contextUsagePercent(ctx)),
          theme.fg("dim", `⏱${formatElapsed(Date.now() - state.sessionStart)}`),
          theme.fg("muted", `⌂ ${shortenCwd(state.cwd || ctx.cwd)}`),
        ];

        const branch = data.getGitBranch();
        if (branch) segments.push(theme.fg("accent", `⎇ ${branch}`));

        const statuses = data.getExtensionStatuses();
        if (statuses.size > 0) segments.push(theme.fg("dim", [...statuses.values()].join(" | ")));

        if (state.lastTps > 0) segments.push(theme.fg("success", `${state.lastTps.toFixed(1)} tok/s`));
        if (state.lastQueryMs > 0) segments.push(theme.fg("dim", formatElapsed(state.lastQueryMs)));

        const line = segments.join(theme.fg("dim", " | "));
        const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
        return [truncateToWidth(line + padding, width)];
      },
    };
  });
};

// ── Extension entry ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new" || event.reason === "fork" || event.reason === "startup") {
      resetTimings();
    }
    disposeFooter();
    installFooter(pi, ctx);
  });

  pi.on("session_switch", (event, ctx) => {
    state.usageTotals = collectTotals(ctx);
    if (event.reason === "new") resetTimings();
    requestRender();
  });

  pi.on("session_tree", (_event, ctx) => {
    state.usageTotals = collectTotals(ctx);
    requestRender();
  });

  pi.on("session_fork", (_event, ctx) => {
    state.usageTotals = collectTotals(ctx);
    requestRender();
  });

  pi.on("agent_start", () => {
    state.agentStartMs = Date.now();
    state.lastTps = 0;
    state.lastQueryMs = 0;
    requestRender();
  });

  pi.on("agent_end", (event) => {
    if (state.agentStartMs === 0) return;
    const output = event.messages.reduce(
      (total, message) => (message.role === "assistant" ? total + outputTokens(message.usage) : total),
      0,
    );
    const elapsed = Date.now() - state.agentStartMs;
    if (elapsed > 0 && output > 0) {
      state.lastTps = output / (elapsed / 1000);
      state.lastQueryMs = elapsed;
    }
    state.agentStartMs = 0;
    requestRender();
  });

  pi.on("turn_end", (event) => {
    if (event.message.role === "assistant") {
      accumulateUsage(state.usageTotals, event.message as AssistantMessage);
      requestRender();
    }
  });

  pi.on("model_select", (event) => {
    state.model = (event.model as ModelRef | null) ?? null;
    requestRender();
  });

  pi.on("session_shutdown", () => {
    disposeFooter();
  });
}
