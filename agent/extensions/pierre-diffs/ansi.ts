/**
 * Minimal ANSI helpers.
 *
 * Only one job: paint a background over character ranges of text that already
 * contains SGR sequences (syntax highlighting). Fg codes are copied verbatim,
 * so the highlight survives; the range background is emitted between characters
 * and restores the line background instead of resetting to the default.
 */

import type { Range } from "./words.ts";

const ESC = "\u001b";

/** Index just past the escape sequence starting at `start`. */
const escapeEnd = (text: string, start: number): number => {
  const next = text[start + 1];
  if (next === "[") {
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
      index++;
    }
    return text.length;
  }
  if (next === "]") {
    let index = start + 2;
    while (index < text.length) {
      if (text[index] === "\u0007") return index + 1;
      if (text[index] === ESC && text[index + 1] === "\\") return index + 2;
      index++;
    }
    return text.length;
  }
  return start + 1;
};

/**
 * Wrap the given plain-text ranges of `highlighted` in `enter`...`exit`.
 * Returns `highlighted` untouched when the two texts disagree, which keeps
 * emphasis from corrupting a line if a highlighter ever rewrites the text.
 */
export const overlayBackground = (
  highlighted: string,
  plain: string,
  ranges: readonly Range[],
  enter: string,
  exit: string,
): string => {
  if (ranges.length === 0 || enter.length === 0) return highlighted;

  let out = "";
  let active = false;
  let range = 0;
  let plainIndex = 0;
  let index = 0;

  const inRange = (position: number): boolean => {
    while (range < ranges.length && ranges[range][1] <= position) range++;
    return range < ranges.length && ranges[range][0] <= position && position < ranges[range][1];
  };

  while (index < highlighted.length) {
    if (highlighted[index] === ESC) {
      const end = escapeEnd(highlighted, index);
      out += highlighted.slice(index, end);
      index = end;
      continue;
    }
    if (highlighted[index] !== plain[plainIndex]) return highlighted;

    const wanted = inRange(plainIndex);
    if (wanted !== active) {
      out += wanted ? enter : exit;
      active = wanted;
    }
    out += highlighted[index];
    index++;
    plainIndex++;
  }

  return active ? out + exit : out;
};
