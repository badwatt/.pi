/**
 * Unit tests for pierre-diffs/words.ts (intra-line diff).
 *
 * Run with: node --test agent/extensions/pierre-diffs/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { changedRanges } from "./words.ts";

const slice = (text: string, ranges: readonly (readonly [number, number])[]): string =>
  ranges.map(([start, end]) => text.slice(start, end)).join("|");

test("word diff marks the changed word on both sides", () => {
  const { before, after } = changedRanges("word-alt", "const a = 1;", "const a = 2;");
  assert.equal(slice("const a = 1;", before), "1");
  assert.equal(slice("const a = 2;", after), "2");
});

test("word-alt emphasizes inserted tokens but not the space between them", () => {
  const { after } = changedRanges("word-alt", "call(a)", "call(a, b)");
  assert.equal(slice("call(a, b)", after), ",|b");
});

test("word-alt ignores whitespace-only edits", () => {
  const { before, after } = changedRanges("word-alt", "a b", "a  b");
  assert.deepEqual(before, []);
  assert.deepEqual(after, []);
});

test("word and word-line still mark whitespace-only edits", () => {
  const word = changedRanges("word", "a b", "a  b");
  assert.equal(word.after.length, 1);
  const wordLine = changedRanges("word-line", "a b", "a  b");
  assert.equal(wordLine.after.length, 1);
});

test("char diff highlights single characters", () => {
  const { before, after } = changedRanges("char", "let x = 1", "let x = 2");
  assert.equal(slice("let x = 1", before), "1");
  assert.equal(slice("let x = 2", after), "2");
});

test("none disables emphasis and identical lines produce nothing", () => {
  assert.deepEqual(changedRanges("none", "a", "b"), { before: [], after: [] });
  assert.deepEqual(changedRanges("word-alt", "same", "same"), { before: [], after: [] });
});

test("long lines fall back to whole-line emphasis", () => {
  const before = "x".repeat(700);
  const after = "y".repeat(700);
  const ranges = changedRanges("word", before, after);
  assert.deepEqual(ranges.before, [[0, 700]]);
  assert.deepEqual(ranges.after, [[0, 700]]);
});

test("pure deletion marks the whole removed side", () => {
  const { before, after } = changedRanges("word", "only left", "");
  assert.deepEqual(before, [[0, 9]]);
  assert.deepEqual(after, []);
});

test("ranges are ordered and non-overlapping", () => {
  const { before } = changedRanges("word", "alpha beta gamma delta", "alpha GAMMA delta");
  const starts = before.map(([start]) => start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  for (let index = 1; index < before.length; index++) {
    assert.ok(before[index][0] >= before[index - 1][1]);
  }
});
