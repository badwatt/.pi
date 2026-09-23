/**
 * custom-footer — pure helpers for formatting, usage aggregation, and footer segments.
 *
 * This module has no runtime dependency on Pi packages (type-only imports only), so the
 * logic can be unit-tested in isolation with `node --test`.
 */
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────

export type UsageTotals = { input: number; output: number };

export type ModelRef = { id: string; provider?: string };

export type TokenUsage = { output?: unknown };

export type ContextColor = "error" | "warning" | "success";

export type ThinkingColor = "warning" | "accent" | "dim" | "muted";

// ── Constants ──────────────────────────────────────────────────────────

const CWD_SEGMENTS = 2;
const PCT_WARNING = 50;
const PCT_ERROR = 75;

// ── Formatting ─────────────────────────────────────────────────────────

/** Compact duration: `500ms`, `12s`, `3m5s`, `2h7m`. */
export const formatElapsed = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remSeconds > 0 ? `${remSeconds}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h${remMinutes > 0 ? `${remMinutes}m` : ""}`;
};

/** Compact count: `999`, `1.5k`. */
export const fmt = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

const tokenCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// ── Usage aggregation ──────────────────────────────────────────────────

export const accumulateUsage = (totals: UsageTotals, message: AssistantMessage): void => {
  totals.input += tokenCount(message.usage?.input);
  totals.output += tokenCount(message.usage?.output);
};

export const outputTokens = (usage: TokenUsage | undefined): number => tokenCount(usage?.output);

/** Sum input/output tokens across the active branch. */
export const collectTotals = (ctx: Pick<ExtensionContext, "sessionManager">): UsageTotals => {
  const totals: UsageTotals = { input: 0, output: 0 };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      accumulateUsage(totals, entry.message as AssistantMessage);
    }
  }
  return totals;
};

// ── Presentation ───────────────────────────────────────────────────────

/** Merge the selected model with the session fallback, keeping the first value found. */
export const resolveModel = (current: ModelRef | null, fallback: ModelRef | null): ModelRef => ({
  id: current?.id ?? fallback?.id ?? "no-model",
  provider: current?.provider ?? fallback?.provider,
});

/** Last `CWD_SEGMENTS` path segments, or the full path when shorter. */
export const shortenCwd = (cwd: string): string => {
  const parts = cwd.split("/");
  return parts.length > CWD_SEGMENTS ? parts.slice(-CWD_SEGMENTS).join("/") : cwd;
};

export const contextPercentColor = (percent: number): ContextColor =>
  percent > PCT_ERROR ? "error" : percent > PCT_WARNING ? "warning" : "success";

export const thinkingColor = (level: string): ThinkingColor =>
  level === "high" ? "warning" : level === "medium" ? "accent" : level === "low" ? "dim" : "muted";

export const renderModel = (theme: Theme, model: ModelRef, thinking: string): string => {
  const marker = theme.fg(thinkingColor(thinking), "◆");
  return model.provider
    ? `${marker} ${theme.fg("dim", model.provider)}${theme.fg("dim", "/")}${theme.fg("accent", model.id)}`
    : `${marker} ${theme.fg("accent", model.id)}`;
};

export const renderTokenStats = (theme: Theme, totals: UsageTotals, percent: number): string =>
  `${theme.fg("accent", `${fmt(totals.input)}/${fmt(totals.output)}`)} ` +
  theme.fg(contextPercentColor(percent), `${percent.toFixed(0)}%`);
