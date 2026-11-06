/**
 * Intra-line diff (`lineDiffType` in @pierre/diffs).
 *
 * Pairs the old/new text of a changed line and reports the character ranges
 * that actually changed, so the renderer can emphasize them the way
 * `word-alt` / `word` / `char` do on the web.
 *
 * The token LCS is capped: past the cap the whole line is reported as changed,
 * which is both correct and cheap for pathological one-line files.
 */

import type { LineDiffType } from "./options.ts";

export type Range = readonly [start: number, end: number];

const TOKEN_LIMIT = 600;
const WHITESPACE = /^\s+$/;

// Words, whitespace runs and single punctuation characters: grouping punctuation
// would make `);` and `});` different tokens and mark the whole run as changed.
const tokenize = (text: string, charMode: boolean): string[] =>
  charMode ? Array.from(text) : (text.match(/\w+|\s+|[^\w\s]/g) ?? []);

/** Longest common subsequence match flags for two token lists. */
const matchFlags = (a: string[], b: string[]): [Uint8Array, Uint8Array] => {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);

  for (let i = a.length - 1; i >= 0; i--) {
    const row = i * width;
    const next = row + width;
    for (let j = b.length - 1; j >= 0; j--) {
      table[row + j] =
        a[i] === b[j] ? table[next + j + 1] + 1 : Math.max(table[next + j], table[row + j + 1]);
    }
  }

  const aFlags = new Uint8Array(a.length);
  const bFlags = new Uint8Array(b.length);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      aFlags[i++] = 1;
      bFlags[j++] = 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return [aFlags, bFlags];
};

/** Merge the unmatched tokens of one side into character ranges. */
const rangesOf = (tokens: string[], flags: Uint8Array, markWhitespace: boolean): Range[] => {
  const ranges: Range[] = [];
  let offset = 0;
  let start = -1;

  tokens.forEach((token, index) => {
    const changed = flags[index] === 0 && (markWhitespace || !WHITESPACE.test(token));
    if (changed && start < 0) start = offset;
    if (!changed && start >= 0) {
      ranges.push([start, offset]);
      start = -1;
    }
    offset += token.length;
  });

  if (start >= 0) ranges.push([start, offset]);
  return ranges;
};

const whole = (text: string): Range[] => (text.length === 0 ? [] : [[0, text.length]]);

/**
 * Character ranges that changed on each side of a paired line.
 * `word-alt` ignores whitespace-only edits; `char` diffs code points one by one.
 */
export const changedRanges = (
  mode: LineDiffType,
  before: string,
  after: string,
): { before: Range[]; after: Range[] } => {
  if (mode === "none" || before === after) return { before: [], after: [] };

  const charMode = mode === "char";
  const a = tokenize(before, charMode);
  const b = tokenize(after, charMode);
  if (a.length === 0 && b.length === 0) return { before: [], after: [] };
  if (a.length > TOKEN_LIMIT || b.length > TOKEN_LIMIT) {
    return { before: whole(before), after: whole(after) };
  }

  const [aFlags, bFlags] = matchFlags(a, b);
  const markWhitespace = mode !== "word-alt";

  return {
    before: rangesOf(a, aFlags, markWhitespace),
    after: rangesOf(b, bFlags, markWhitespace),
  };
};
