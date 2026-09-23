/**
 * Unit tests for custom-footer/format.ts (pure helpers).
 *
 * Run with: node --test agent/extensions/custom-footer/format.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  accumulateUsage,
  collectTotals,
  contextPercentColor,
  fmt,
  formatElapsed,
  outputTokens,
  renderModel,
  renderTokenStats,
  resolveModel,
  shortenCwd,
  thinkingColor,
  type UsageTotals,
} from "./format.ts";

const theme = { fg: (color: string, text: string) => `[${color}:${text}]` } as unknown as Theme;

test("formatElapsed", () => {
  assert.equal(formatElapsed(0), "0ms");
  assert.equal(formatElapsed(999), "999ms");
  assert.equal(formatElapsed(1000), "1s");
  assert.equal(formatElapsed(59_000), "59s");
  assert.equal(formatElapsed(60_000), "1m");
  assert.equal(formatElapsed(61_000), "1m1s");
  assert.equal(formatElapsed(3_600_000), "1h");
  assert.equal(formatElapsed(3_660_000), "1h1m");
});

test("fmt", () => {
  assert.equal(fmt(0), "0");
  assert.equal(fmt(999), "999");
  assert.equal(fmt(1000), "1.0k");
  assert.equal(fmt(1500), "1.5k");
});

test("resolveModel merges current with fallback", () => {
  assert.deepEqual(resolveModel({ id: "m" }, null), { id: "m", provider: undefined });
  assert.deepEqual(resolveModel(null, { id: "f", provider: "p" }), { id: "f", provider: "p" });
  assert.deepEqual(resolveModel({ id: "m" }, { id: "f", provider: "p" }), { id: "m", provider: "p" });
  assert.deepEqual(resolveModel(null, null), { id: "no-model", provider: undefined });
});

test("shortenCwd keeps the last two segments", () => {
  assert.equal(shortenCwd("/home/user/project"), "user/project");
  assert.equal(shortenCwd("/a"), "/a");
  assert.equal(shortenCwd("a/b"), "a/b");
  assert.equal(shortenCwd("/a/b/c"), "b/c");
});

test("contextPercentColor thresholds", () => {
  assert.equal(contextPercentColor(0), "success");
  assert.equal(contextPercentColor(50), "success");
  assert.equal(contextPercentColor(51), "warning");
  assert.equal(contextPercentColor(75), "warning");
  assert.equal(contextPercentColor(76), "error");
});

test("thinkingColor", () => {
  assert.equal(thinkingColor("high"), "warning");
  assert.equal(thinkingColor("medium"), "accent");
  assert.equal(thinkingColor("low"), "dim");
  assert.equal(thinkingColor("off"), "muted");
  assert.equal(thinkingColor("unknown"), "muted");
});

test("outputTokens normalizes non-finite and missing values", () => {
  assert.equal(outputTokens({ output: 5 }), 5);
  assert.equal(outputTokens({ output: "3" }), 3);
  assert.equal(outputTokens({ output: "nope" }), 0);
  assert.equal(outputTokens(undefined), 0);
});

test("accumulateUsage", () => {
  const totals: UsageTotals = { input: 0, output: 0 };
  accumulateUsage(totals, { usage: { input: 10, output: 20 } } as never);
  assert.deepEqual(totals, { input: 10, output: 20 });
  accumulateUsage(totals, { usage: { input: "x", output: undefined } } as never);
  assert.deepEqual(totals, { input: 10, output: 20 });
});

test("collectTotals sums assistant messages on the branch", () => {
  const ctx = {
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "assistant", usage: { input: 5, output: 7 } } },
        { type: "message", message: { role: "user" } },
        { type: "other" },
      ],
    },
  } as unknown as Parameters<typeof collectTotals>[0];
  assert.deepEqual(collectTotals(ctx), { input: 5, output: 7 });
});

test("renderModel with and without provider", () => {
  assert.equal(renderModel(theme, { id: "gpt", provider: "openai" }, "medium"), "[accent:◆] [dim:openai][dim:/][accent:gpt]");
  assert.equal(renderModel(theme, { id: "gpt" }, "off"), "[muted:◆] [accent:gpt]");
});

test("renderTokenStats applies percent color", () => {
  assert.equal(renderTokenStats(theme, { input: 1234, output: 567 }, 80), "[accent:1.2k/567] [error:80%]");
  assert.equal(renderTokenStats(theme, { input: 0, output: 0 }, 50), "[accent:0/0] [success:50%]");
});
