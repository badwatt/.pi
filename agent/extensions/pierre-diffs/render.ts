/**
 * Diff renderer: pierre layout model, terminal output.
 *
 * Everything width- or colour-related is injected through `Renderer`, so this
 * module stays dependency free and unit testable.
 *
 * Layout rules map 1:1 to @pierre/diffs options:
 *   diffStyle: unified | split     -> stacked rows or two columns
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
const SPLIT_MIN_WIDTH = 56;
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
  maxLines: number;
}

interface Side {
  row: DiffRow;
  ranges: readonly Range[];
}

interface Pair {
  left?: Side;
  right?: Side;
}

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
 * layouts share this single pass.
 */
const pairRows = (rows: readonly DiffRow[], lineDiff: DiffConfig["lineDiff"]): Pair[] => {
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
      const ranges =
        removed && added ? changedRanges(lineDiff, removed.text, added.text) : { before: [], after: [] };
      pairs.push({
        left: removed && { row: removed, ranges: ranges.before },
        right: added && { row: added, ranges: ranges.after },
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

const capLines = <C>(lines: string[], limits: RenderLimits, renderer: Renderer<C>, width: number): string[] => {
  const note = (count: number): string =>
    renderer.truncate(renderer.fg("dim", `${HIDDEN} ${count} more diff lines`), width);
  if (lines.length <= limits.maxLines) return lines;
  const kept = limits.maxLines > 1 ? lines.slice(0, limits.maxLines - 1) : [];
  return [...kept, note(lines.length - kept.length)];
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
  const split = config.style === "split" && width >= SPLIT_MIN_WIDTH;
  const numberWidth = lineNumberWidth(patch);
  const columnWidth = split ? Math.floor((width - SPLIT_DIVIDER.length) / 2) : width;
  const rightWidth = split ? width - columnWidth - SPLIT_DIVIDER.length : 0;

  const gutterWidth = config.lineNumbers ? (split ? numberWidth : numberWidth * 2 + 1) + 1 : 0;
  const markerWidth = config.indicators === "none" ? 0 : 2;
  const headWidth = gutterWidth + markerWidth;
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

    const bodyLines = config.wrap ? renderer.wrap(text, contentWidth) : [renderer.truncate(text, contentWidth)];
    return bodyLines.map((line) => {
      const fill = Math.max(0, contentWidth - renderer.width(line));
      const padded = head + line + " ".repeat(fill);
      return lineBg ? padded + RESET_BG : padded;
    });
  };

  const lines: string[] = [];
  patch.hunks.forEach((hunk, hunkIndex) => {
    if (hunkIndex > 0) {
      lines.push(...separatorLines(hunk, patch.hunks[hunkIndex - 1], config, renderer, width));
    }
    for (const pair of pairRows(hunk.rows, config.lineDiff)) {
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
  });

  return capLines(lines, limits, renderer, width);
};
