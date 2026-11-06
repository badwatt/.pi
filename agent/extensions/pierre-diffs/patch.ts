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
}

export interface DiffHunk {
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

const count = (value: string | undefined): number => (value === undefined ? 1 : Number(value));

/** Parse a unified diff into hunks. Unrelated leading/trailing lines are ignored. */
export const parsePatch = (patch: string): ParsedPatch => {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
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

    // Anything before the first hunk is a file header; anything after a
    // non-diff line ends the hunk.
    if (!current) continue;
    const marker = line[0];
    if (marker === "\\") continue; // "\ No newline at end of file"
    if (marker === " ") {
      current.rows.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
      continue;
    }
    if (marker === "-") {
      deletions++;
      current.rows.push({ kind: "deletion", oldNo: oldNo++, text: line.slice(1) });
      continue;
    }
    if (marker === "+") {
      additions++;
      current.rows.push({ kind: "addition", newNo: newNo++, text: line.slice(1) });
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
      rows.push({ kind: "addition", newNo: additions, text: content.slice(start, stop) });
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
