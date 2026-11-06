/**
 * Unit tests for pierre-diffs/ansi.ts (background overlay).
 *
 * Run with: node --test agent/extensions/pierre-diffs/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { overlayBackground } from "./ansi.ts";

const RED = "\u001b[38;2;255;0;0m";
const RESET_FG = "\u001b[39m";
const BG = "\u001b[48;2;0;80;0m";

test("overlay wraps only the requested ranges", () => {
  const result = overlayBackground("abcdef", "abcdef", [[2, 4]], BG, "\u001b[49m");
  assert.equal(result, `ab${BG}cd\u001b[49mef`);
});

test("overlay keeps existing SGR sequences and their order", () => {
  const highlighted = `${RED}abc${RESET_FG}`;
  const result = overlayBackground(highlighted, "abc", [[1, 2]], BG, "\u001b[49m");
  assert.equal(result, `${RED}a${BG}b\u001b[49mc${RESET_FG}`);
});

test("overlay restores the caller background after emphasis", () => {
  const lineBg = "\u001b[48;2;10;10;10m";
  const result = overlayBackground("ab", "ab", [[0, 1]], BG, lineBg);
  assert.equal(result, `${BG}a${lineBg}b`);
});

test("overlay leaves the text alone without ranges or an escape", () => {
  assert.equal(overlayBackground("abc", "abc", [], BG, ""), "abc");
  assert.equal(overlayBackground("abc", "abc", [[0, 1]], "", ""), "abc");
});

test("overlay bails out when the highlighted text diverges", () => {
  const highlighted = `${RED}aXc${RESET_FG}`;
  assert.equal(overlayBackground(highlighted, "abc", [[0, 3]], BG, ""), highlighted);
});

test("overlay handles OSC sequences and wide characters", () => {
  const linked = `\u001b]8;;https://x\u0007ab\u001b]8;;\u0007`;
  const result = overlayBackground(linked, "ab", [[0, 2]], BG, "");
  assert.equal(result, `\u001b]8;;https://x\u0007${BG}ab\u001b]8;;\u0007`);
});
