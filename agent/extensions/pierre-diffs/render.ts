/**
 * Diff renderer: pierre layout model, terminal output.
 *
 * Everything width- or colour-related is injected through `Renderer`, so this
 * module stays dependency free and unit testable.
 *
 * Layout rules map 1:1 to @pierre/diffs options:
 *   diffStyle: auto | unified | split -> stacked rows, two columns, or two
 *                                      columns only when the width allows it
 *   diffIndicators: bars | classic | none
 *   lineDiffType                   -> intra-line emphasis (see words.ts)
 *   overflow: wrap | scroll        -> wrap text or clip it
 *   hunkSeparators: line-info | line-info-basic | simple | metadata | none
 *   disableLineNumbers / disableBackground / syntaxHighlight
 */

import { overlayBackground } from "./ansi.ts";
import type { DiffConfig } from "./options.ts";
import { lineNumberWidth, type DiffHunk, type DiffRow, type ParsedPatch, type RowKind } from "./patch.ts";
import { changedRanges, type Range } from "./words.ts";

const RESET_BG = "\u001b[49m";
const BAR = "\u258e";
const HIDDEN = "\u22ef";
const SPLIT_DIVIDER = " \u2502 ";
/** Text columns each side needs: `split` keeps a floor, `auto` asks for comfort. */
const SPLIT_MIN_TEXT = 8;
const SPLIT_AUTO_TEXT = 32;
const MIN_CONTENT_WIDTH = 4;

export interface Renderer<C = unknown> {
  /** Semantic theme colour (e.g. "toolDiffAdded", "dim"). */
  fg(token: string, text: string): string;
  /** SGR prefix for a concrete background colour, "" when there is none. */
  bg(color: C | undefined): string;
  /** Visible columns of a styled string. */
  width(text: string): number;
  wrap(text: string, width: number): string[];
  truncate(text: string, width: number): string;
  /** Syntax-highlight one line of code; returns the text unchanged when unsupported. */
  highlight(text: string, kind: RowKind): string;
}

export interface Palette<C = unknown> {
  added: C;
  removed: C;
  addedEmphasis: C;
  removedEmphasis: C;
}

export interface RenderLimits {
  /** Hard cap on produced lines; layout stops as soon as it is reached. */
  maxLines: number;
  /** Shown in place of the truncated output (e.g. "⋯ diff truncated · ctrl+o"). */
  truncatedNote?: string;
  /**
   * File header for patches that span several files (a git diff of everything
   * a tool changed). A changed file replaces the "unchanged lines" separator,
   * whose counts are meaningless across files.
   */
  fileHeader?: (file: string) => string;
}

interface Side {
  row: DiffRow;
  ranges: readonly Range[];
}

interface Pair {
  left?: Side;
  right?: Side;
}

type RangePair = { before: readonly Range[]; after: readonly Range[] };

const EMPTY_RANGES: RangePair = { before: [], after: [] };

const fgTokenFor = (kind: RowKind): string =>
  kind === "addition" ? "toolDiffAdded" : kind === "deletion" ? "toolDiffRemoved" : "toolDiffContext";

const markerFor = (kind: RowKind, indicators: DiffConfig["indicators"]): string => {
  if (indicators === "bars") return kind === "addition" ? BAR : kind === "deletion" ? BAR : " ";
  if (indicators === "classic") return kind === "addition" ? "+" : kind === "deletion" ? "-" : " ";
  return "";
};

/**
 * Pair deletion and addition runs row by row (pierre's split alignment).
 * Flattening a pair list reproduces the original unified row order, so both
 * layouts share this single pass. `ranges` is injected so the layout estimate
 * can reuse the pairing without paying for the intra-line diff.
 */
const pairRows = (rows: readonly DiffRow[], ranges: (removed: DiffRow, added: DiffRow) => RangePair): Pair[] => {
  const pairs: Pair[] = [];
  let index = 0;

  const takeRun = (kind: RowKind): DiffRow[] => {
    const run: DiffRow[] = [];
    while (index < rows.length && rows[index].kind === kind) run.push(rows[index++]);
    return run;
  };

  const pushPaired = (deletions: DiffRow[], additions: DiffRow[]): void => {
    const height = Math.max(deletions.length, additions.length);
    for (let offset = 0; offset < height; offset++) {
      const removed = deletions[offset];
      const added = additions[offset];
      const changed = removed && added ? ranges(removed, added) : EMPTY_RANGES;
      pairs.push({
        left: removed && { row: removed, ranges: changed.before },
        right: added && { row: added, ranges: changed.after },
      });
    }
  };

  while (index < rows.length) {
    const row = rows[index];
    if (row.kind === "context") {
      pairs.push({ left: { row, ranges: [] } });
      index++;
      continue;
    }
    if (row.kind === "deletion") {
      const deletions = takeRun("deletion");
      pushPaired(deletions, takeRun("addition"));
      continue;
    }
    pushPaired([], takeRun("addition"));
  }

  return pairs;
};

/** Wrapped rows one line needs; code is monospace, so length is a fair proxy. */
const heightOf = (text: string, textWidth: number): number =>
  Math.max(1, Math.ceil(text.length / Math.max(1, textWidth)));

interface LayoutRows {
  stacked: number;
  split: number;
}

/**
 * Wrapped rows both candidate layouts need, measured in one pass over the pairs
 * (the intra-line diff is skipped: only text lengths matter here).
 */
const layoutRows = (
  patch: ParsedPatch,
  stackedWidth: number,
  leftWidth: number,
  rightWidth: number,
): LayoutRows => {
  let stacked = 0;
  let split = 0;

  for (const hunk of patch.hunks) {
    for (const pair of pairRows(hunk.rows, () => EMPTY_RANGES)) {
      const left = pair.left?.row.text;
      const right = pair.right?.row.text;

      if (left !== undefined) stacked += heightOf(left, stackedWidth);
      if (right !== undefined) stacked += heightOf(right, stackedWidth);

      const leftRows = left === undefined ? 0 : heightOf(left, leftWidth);
      // A context row has no right side of its own, but it spans both columns.
      const rightRows =
        right !== undefined
          ? heightOf(right, rightWidth)
          : left === undefined
            ? 0
            : heightOf(left, rightWidth);
      split += Math.max(leftRows, rightRows);
    }
  }

  return { stacked, split };
};

const repeatToWidth = (glyph: string, width: number): string => glyph.repeat(Math.max(0, width));

/** Line number gutter for one cell (both numbers in unified, one in split). */
const gutterFor = (row: DiffRow, useNewSide: boolean, width: number, split: boolean): string => {
  const format = (value: number | undefined): string =>
    (value === undefined ? "" : String(value)).padStart(width);
  return split ? format(useNewSide ? row.newNo : row.oldNo) : `${format(row.oldNo)} ${format(row.newNo)}`;
};

/** `@@`, rules and info bars shown between hunks. */
const separatorLines = <C>(
  hunk: DiffHunk,
  previous: DiffHunk,
  config: DiffConfig,
  renderer: Renderer<C>,
  width: number,
): string[] => {
  if (config.separators === "none") return [];
  if (config.separators === "metadata") return [renderer.fg("toolDiffContext", hunk.header)];

  const skipped = Math.max(0, hunk.oldStart - (previous.oldStart + previous.oldCount));
  const label = `${HIDDEN} ${skipped} unchanged ${skipped === 1 ? "line" : "lines"}`;

  if (config.separators === "simple") return [renderer.fg("toolDiffContext", repeatToWidth("\u2500", width))];
  if (config.separators === "line-info-basic") {
    const padded = `${label} `;
    const line = padded + repeatToWidth("\u2500", width - padded.length);
    return [renderer.fg("dim", renderer.truncate(line, width))];
  }

  const head = `\u256d\u2500 ${label} `;
  const line = head + repeatToWidth("\u2500", width - head.length - 1) + "\u256e";
  return [renderer.fg("dim", renderer.truncate(line, width))];
};

/** Render a parsed patch into styled terminal lines for the given width. */
export const renderPatch = <C>(
  patch: ParsedPatch,
  config: DiffConfig,
  renderer: Renderer<C>,
  palette: Palette<C>,
  width: number,
  limits: RenderLimits,
): string[] => {
  const numberWidth = lineNumberWidth(patch);
  const markerWidth = config.indicators === "none" ? 0 : 2;

  // Gutters and markers eat into the width depending on the diff, so both
  // layouts are measured in text columns. `auto` then picks the layout that
  // shows the diff in fewer wrapped rows: two narrow columns win on paired
  // changes, but lose as soon as the lines only fit in the wide one.
  const unifiedHeadWidth = (config.lineNumbers ? numberWidth * 2 + 2 : 0) + markerWidth;
  const splitColumnWidth = Math.floor((width - SPLIT_DIVIDER.length) / 2);
  const splitHeadWidth = (config.lineNumbers ? numberWidth + 1 : 0) + markerWidth;
  const splitTextWidth = splitColumnWidth - splitHeadWidth;
  const splitRightTextWidth = width - splitColumnWidth - SPLIT_DIVIDER.length - splitHeadWidth;

  const roomy = splitTextWidth >= SPLIT_AUTO_TEXT;
  const rows =
    config.style === "auto" && roomy
      ? layoutRows(patch, width - unifiedHeadWidth, splitTextWidth, splitRightTextWidth)
      : undefined;

  const split =
    config.style === "split"
      ? splitTextWidth >= SPLIT_MIN_TEXT
      : rows !== undefined && rows.split < rows.stacked;

  const columnWidth = split ? splitColumnWidth : width;
  const rightWidth = split ? width - splitColumnWidth - SPLIT_DIVIDER.length : 0;
  const headWidth = split ? splitHeadWidth : unifiedHeadWidth;
  const textWidth = Math.max(MIN_CONTENT_WIDTH, columnWidth - headWidth);
  const rightTextWidth = Math.max(MIN_CONTENT_WIDTH, rightWidth - headWidth);

  const blank = (cellWidth: number): string => " ".repeat(cellWidth);
  const divider = renderer.fg("toolDiffContext", SPLIT_DIVIDER);

  const paint = (side: Side, useNewSide: boolean, contentWidth: number): string[] => {
    const { row, ranges } = side;
    const token = fgTokenFor(row.kind);
    const lineBg =
      config.background && row.kind !== "context"
        ? renderer.bg(row.kind === "addition" ? palette.added : palette.removed)
        : "";
    const emphasis = renderer.bg(
      row.kind === "addition" ? palette.addedEmphasis : palette.removedEmphasis,
    );
    const useSyntax = config.syntax && (row.kind === "context" || config.background);
    const body = useSyntax ? renderer.highlight(row.text, row.kind) : renderer.fg(token, row.text);
    const text =
      ranges.length > 0 && emphasis
        ? overlayBackground(body, row.text, ranges, emphasis, lineBg || RESET_BG)
        : body;

    const gutter = config.lineNumbers
      ? `${renderer.fg("toolDiffContext", gutterFor(row, useNewSide, numberWidth, split))} `
      : "";
    const marker =
      config.indicators === "none" ? "" : `${renderer.fg(token, markerFor(row.kind, config.indicators))} `;
    const head = lineBg + gutter + marker;

    const bodyLines = config.wrap
      ? renderer.wrap(text, contentWidth)
      : [renderer.truncate(text, contentWidth)];
    const indent = " ".repeat(headWidth);

    return bodyLines.map((line, index) => {
      const fill = Math.max(0, contentWidth - renderer.width(line));
      // Wrapped continuation rows repeat neither the number nor the marker.
      const padded = (index === 0 ? head : indent) + line + " ".repeat(fill);
      return lineBg ? padded + RESET_BG : padded;
    });
  };

  const lines: string[] = [];
  let truncated = false;
  let paintedFile: string | undefined;

  // Layout stops at the cap instead of painting the whole diff and slicing it.
  // A 1200 row diff costs one frame instead of ~60ms of discarded work.
  const paintPairs = (hunk: DiffHunk): void => {
    for (const pair of pairRows(hunk.rows, (removed, added) =>
      changedRanges(config.lineDiff, removed.text, added.text),
    )) {
      if (lines.length >= limits.maxLines) {
        truncated = true;
        return;
      }

      if (!split) {
        if (pair.left) lines.push(...paint(pair.left, true, textWidth));
        if (pair.right) lines.push(...paint(pair.right, true, textWidth));
        continue;
      }

      const left = pair.left ? paint(pair.left, false, textWidth) : [];
      // A context row has no right side of its own: it spans both columns.
      const right = pair.right
        ? paint(pair.right, true, rightTextWidth)
        : pair.left
          ? paint(pair.left, true, rightTextWidth)
          : [];
      const height = Math.max(left.length, right.length);
      for (let line = 0; line < height; line++) {
        lines.push((left[line] ?? blank(columnWidth)) + divider + (right[line] ?? blank(rightWidth)));
      }
    }
  };

  for (let hunkIndex = 0; hunkIndex < patch.hunks.length && !truncated; hunkIndex++) {
    const hunk = patch.hunks[hunkIndex];
    const file = hunk.file;

    if (file !== undefined && file !== paintedFile) {
      paintedFile = file;
      if (limits.fileHeader) {
        if (lines.length > 0) lines.push("");
        lines.push(limits.fileHeader(file));
      }
    } else if (hunkIndex > 0) {
      lines.push(...separatorLines(hunk, patch.hunks[hunkIndex - 1], config, renderer, width));
    }
    paintPairs(hunk);
  }

  if (!truncated) return lines;

  const note = limits.truncatedNote;
  const kept = lines.slice(0, Math.max(0, note ? limits.maxLines - 1 : limits.maxLines));
  return note ? [...kept, renderer.truncate(renderer.fg("dim", note), width)] : kept;
};
