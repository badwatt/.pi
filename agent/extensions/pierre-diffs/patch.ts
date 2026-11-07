/**
 * Unified diff parser.
 *
 * Input is the `details.patch` string produced by the built-in `edit` tool
 * (a `createTwoFilesPatch` result) or any git-style unified diff. Output keeps
 * both line numbers, which the pretty `details.diff` string does not carry.
 */

export type RowKind = "context" | "addition" | "deletion";

export interface DiffRow {
  kind: RowKind;
  oldNo?: number;
  newNo?: number;
  text: string;
  /** The file does not end with a newline after this row (`\ No newline …`). */
  noNewline?: boolean;
}

export interface DiffHunk {
  /** Path from the file header, when the patch names one (git diffs do). */
  file?: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  rows: DiffRow[];
}

export interface ParsedPatch {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** `--- a/x` / `+++ b/x`: the file a hunk belongs to (unambiguous with spaces). */
const MINUS_FILE = /^--- (.+)$/;
const PLUS_FILE = /^\+\+\+ (.+)$/;

const count = (value: string | undefined): number => (value === undefined ? 1 : Number(value));

/**
 * Row text as the TUI measures it. Pi counts a tab as three columns everywhere
 * (`visibleWidth`, the built-in diff) and a carriage return would send the
 * cursor back to column 0 mid-row, so both are normalised here: the intra-line
 * ranges and the padding math then agree with what is painted.
 */
const displayText = (text: string): string => text.replace(/\r$/, "").replace(/\t/g, "   ");

/** Strip the `a/` or `b/` prefix and the quotes git adds to unusual paths. */
const cleanPath = (path: string): string => {
  const trimmed = path.trim();
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return unquoted.replace(/^[ab]\//, "");
};

/**
 * Parse a unified diff into hunks. Unrelated leading/trailing lines are ignored.
 *
 * Hunk boundaries follow the diff markers, not the `@@` counts: a patch that
 * spans several files must separate them with a non-diff line (`diff --git`),
 * which git always emits. Without one, the next `---` reads as a deletion row.
 */
export const parsePatch = (patch: string): ParsedPatch => {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let file: string | undefined;
  let minusFile: string | undefined;
  let oldNo = 0;
  let newNo = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        file,
        oldStart: Number(header[1]),
        oldCount: count(header[2]),
        newStart: Number(header[3]),
        newCount: count(header[4]),
        header: line,
        rows: [],
      };
      hunks.push(current);
      oldNo = current.oldStart;
      newNo = current.newStart;
      continue;
    }

    // Anything outside a hunk is a file header; a line that is not a diff
    // marker ends the hunk.
    if (!current) {
      const minus = MINUS_FILE.exec(line);
      if (minus) {
        minusFile = cleanPath(minus[1]);
        continue;
      }
      const plus = PLUS_FILE.exec(line);
      if (plus) {
        // `+++ /dev/null` is a deleted file: it keeps the name from `---`.
        file = plus[1].trim() === "/dev/null" ? minusFile : cleanPath(plus[1]);
      }
      continue;
    }
    const marker = line[0];
    if (marker === "\\") {
      // Not a row of its own: the marker belongs to the line above it.
      const last = current.rows[current.rows.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    if (marker === " ") {
      current.rows.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: displayText(line.slice(1)) });
      continue;
    }
    if (marker === "-") {
      deletions++;
      current.rows.push({ kind: "deletion", oldNo: oldNo++, text: displayText(line.slice(1)) });
      continue;
    }
    if (marker === "+") {
      additions++;
      current.rows.push({ kind: "addition", newNo: newNo++, text: displayText(line.slice(1)) });
      continue;
    }
    current = undefined;
  }

  return { hunks, additions, deletions };
};

/**
 * Model a whole file as one all-additions hunk (pierre renders added files the
 * same way). Only `limit` rows are materialised, but `additions` stays exact:
 * the scan is a single `indexOf` pass, so a large write costs no line array.
 */
export const addedFilePatch = (content: string, limit: number): ParsedPatch => {
  const rows: DiffRow[] = [];
  const end = content.endsWith("\n") ? content.length - 1 : content.length;
  let start = 0;
  let additions = 0;

  while (content.length > 0 && start <= end) {
    const newline = content.indexOf("\n", start);
    const stop = newline === -1 || newline > end ? end : newline;
    additions++;
    if (rows.length < limit) {
      rows.push({ kind: "addition", newNo: additions, text: displayText(content.slice(start, stop)) });
    }
    if (stop === end) break;
    start = stop + 1;
  }

  return {
    hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: additions, header: "", rows }],
    additions,
    deletions: 0,
  };
};

/** Widest line number in the patch, as a digit count. */
export const lineNumberWidth = (patch: ParsedPatch): number => {
  let max = 0;
  for (const hunk of patch.hunks) {
    for (const row of hunk.rows) {
      max = Math.max(max, row.oldNo ?? 0, row.newNo ?? 0);
    }
  }
  return String(Math.max(1, max)).length;
};
