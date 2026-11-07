/**
 * Unit tests for pierre-diffs/render.ts (layout + painting).
 *
 * Run with: node --test agent/extensions/pierre-diffs/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig, type DiffConfig, type DiffOptions } from "./options.ts";
import { parsePatch, type ParsedPatch } from "./patch.ts";
import { renderPatch, type Palette, type Renderer } from "./render.ts";

const PALETTE: Palette<string> = {
  added: "a",
  removed: "r",
  addedEmphasis: "A",
  removedEmphasis: "R",
};

const SGR = /\u001b\[[0-9;]*[A-Za-z]/g;
const MARKER = /<[^>]*>|\{[a-zA-Z]+\}/g;
const ZERO_WIDTH = /^(?:<[^>]*>|\{[a-zA-Z]+\}|\u001b\[[0-9;]*[A-Za-z])/;

/** Strip styling markers and ANSI escapes so layout can be asserted as text. */
const strip = (lines: string[]): string[] => lines.map((line) => line.replace(MARKER, "").replace(SGR, ""));

const splitVisible = (text: string, width: number): string[] => {
  const lines: string[] = [];
  let current = "";
  let used = 0;
  let index = 0;
  while (index < text.length) {
    const marker = ZERO_WIDTH.exec(text.slice(index));
    if (marker) {
      current += marker[0];
      index += marker[0].length;
      continue;
    }
    if (used === width) {
      lines.push(current);
      current = "";
      used = 0;
    }
    current += text[index];
    used++;
    index++;
  }
  lines.push(current);
  return lines;
};

/**
 * Fake renderer. `ansi` decides whether colours are real SGR sequences (needed
 * for the intra-line overlay, which only understands ANSI) or readable markers.
 */
const fakeRenderer = (ansi = false, overrides: Partial<Renderer<string>> = {}): Renderer<string> => ({
  fg: ansi ? (_token, text) => `\u001b[32m${text}\u001b[39m` : (token, text) => `<${token}>${text}`,
  bg: (color) => (color === undefined ? "" : `{${color}}`),
  width: (text) => text.replace(MARKER, "").replace(SGR, "").length,
  wrap: splitVisible,
  truncate: (text, width) => splitVisible(text, width)[0] ?? "",
  highlight: (text) => text,
  ...overrides,
});

const CONFIG: DiffOptions = {
  enabled: true,
  diffStyle: "unified",
  diffIndicators: "bars",
  lineDiffType: "none",
  overflow: "wrap",
  hunkSeparators: "line-info",
  lineNumbers: true,
  backgrounds: true,
  syntaxHighlight: false,
};

const config = (overrides: Partial<DiffConfig> = {}): DiffConfig => ({
  ...resolveConfig(CONFIG),
  ...overrides,
});

const parse = (source: string): ParsedPatch => parsePatch(source);

const SAMPLE = [
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
].join("\n");

const render = (
  source: string,
  overrides: Partial<DiffConfig>,
  width: number,
  renderer = fakeRenderer(),
): string[] => renderPatch(parse(source), config(overrides), renderer, PALETTE, width, { maxLines: 200 });

test("unified layout renders both gutters, markers and full-width rows", () => {
  const lines = render(SAMPLE, {}, 40);
  assert.deepEqual(strip(lines), [
    "1 1   const a = 1;                      ",
    "2   ▎ const b = 2;                      ",
    "  2 ▎ const b = 3;                      ",
    "  3 ▎ const c = 4;                      ",
    "3 4   const d = 5;                      ",
  ]);
  for (const line of strip(lines)) assert.equal(line.length, 40);
});

test("split layout pairs deletions with additions and spans context rows", () => {
  const lines = strip(render(SAMPLE, { style: "split" }, 100));
  const row = (left: string, right: string): string => left.padEnd(48) + " │ " + right.padEnd(49);
  assert.deepEqual(lines, [
    row("1   const a = 1;", "1   const a = 1;"),
    row("2 ▎ const b = 2;", "2 ▎ const b = 3;"),
    row("", "3 ▎ const c = 4;"),
    row("3   const d = 5;", "4   const d = 5;"),
  ]);
});

test("auto splits only when both columns stay comfortable", () => {
  const wide = strip(render(SAMPLE, { style: "auto" }, 100));
  assert.ok(wide[0].includes("│"));
  assert.equal(wide.length, 4);

  const narrow = strip(render(SAMPLE, { style: "auto" }, 74));
  assert.ok(!narrow[0].includes("│"));
  assert.equal(narrow.length, 5);
});

test("explicit split forces two columns down to the legibility floor", () => {
  assert.ok(strip(render(SAMPLE, { style: "split" }, 60))[0].includes("│"));
  const tooNarrow = strip(render(SAMPLE, { style: "split" }, 20));
  assert.ok(!tooNarrow[0].includes("│"));
  assert.equal(tooNarrow.length, 5);
});

test("indicators switch between bars, classic and none", () => {
  assert.ok(strip(render(SAMPLE, { indicators: "bars" }, 40))[1].includes("▎"));
  assert.ok(strip(render(SAMPLE, { indicators: "classic" }, 40))[1].includes("- const b = 2;"));
  assert.ok(strip(render(SAMPLE, { indicators: "classic" }, 40))[2].includes("+ const b = 3;"));
  assert.ok(!strip(render(SAMPLE, { indicators: "none" }, 40))[1].includes("▎"));
});

test("line numbers can be hidden", () => {
  const lines = strip(render(SAMPLE, { lineNumbers: false }, 40));
  assert.ok(lines[0].startsWith("  const a = 1;"));
  assert.ok(lines[1].startsWith("▎ const b = 2;"));
});

test("backgrounds tint changed rows and reset every line", () => {
  const lines = render(SAMPLE, {}, 30);
  assert.ok(lines[0].startsWith("<toolDiffContext>1 1 "));
  assert.ok(lines[1].startsWith("{r}"));
  assert.ok(lines[2].startsWith("{a}"));
  for (const line of lines.slice(1, 4)) assert.ok(line.endsWith("\u001b[49m"));
});

test("disabling backgrounds keeps change colours only", () => {
  const lines = render(SAMPLE, { background: false }, 30);
  assert.ok(!lines[1].includes("{r}"));
  assert.ok(lines[1].includes("<toolDiffRemoved>"));
});

test("word diff emphasizes the changed characters of a paired row", () => {
  const lines = render("@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;", { lineDiff: "word" }, 40, fakeRenderer(true));
  assert.ok(lines[0].includes("{R}"));
  assert.ok(lines[1].includes("{A}"));
  assert.deepEqual(strip(lines), ["1   ▎ const a = 1;                      ", "  1 ▎ const a = 2;                      "]);
});

test("lineDiffType none suppresses emphasis", () => {
  const lines = render("@@ -1,1 +1,1 @@\n-a = 1\n+a = 2", { lineDiff: "none" }, 40, fakeRenderer(true));
  for (const line of lines) assert.ok(!line.includes("{A}") && !line.includes("{R}"));
});

test("syntax highlighting covers context rows and, with backgrounds, changes", () => {
  const highlight = (text: string): string => `[${text}]`;
  const withBg = render(SAMPLE, { syntax: true }, 40, fakeRenderer(false, { highlight }));
  assert.ok(withBg[0].includes("[const a = 1;]"));
  assert.ok(withBg[1].includes("[const b = 2;]"));

  const withoutBg = render(SAMPLE, { background: false, syntax: true }, 40, fakeRenderer(false, { highlight }));
  assert.ok(withoutBg[0].includes("[const a = 1;]"));
  assert.ok(!withoutBg[1].includes("[const b = 2;]"));
});

test("hunk separators report the skipped line count", () => {
  const twoHunks = "@@ -1,2 +1,2 @@\n-one\n+ONE\n tail\n@@ -40,1 +40,1 @@\n-forty\n+FORTY";
  const separator = (separators: DiffConfig["separators"]): string =>
    strip(render(twoHunks, { separators }, 40))[3];

  assert.match(separator("line-info"), /^╭─ ⋯ 37 unchanged lines ─+╮$/);
  assert.match(separator("line-info-basic"), /^⋯ 37 unchanged lines ─+$/);
  assert.equal(separator("simple"), "─".repeat(40));
  assert.equal(separator("metadata"), "@@ -40,1 +40,1 @@");
  assert.equal(strip(render(twoHunks, { separators: "none" }, 40)).length, 5);
});

test("long lines wrap onto continuation rows without repeating the gutter", () => {
  const long = `@@ -1,1 +1,1 @@\n-${"a".repeat(30)}\n+${"b".repeat(30)}`;
  const wrapped = strip(render(long, {}, 24));

  assert.equal(wrapped.length, 4);
  assert.ok(wrapped[0].startsWith("1   ▎ "));
  assert.ok(wrapped[1].startsWith("      "));
  assert.ok(wrapped[2].startsWith("  1 ▎ "));
  assert.ok(wrapped[3].startsWith("      "));
  for (const line of wrapped) assert.equal(line.length, 24);
});

test("clipped lines keep the column width and end with an ellipsis", () => {
  const long = `@@ -1,1 +1,1 @@\n-${"a".repeat(30)}\n+${"b".repeat(30)}`;
  const clip = (text: string, width: number): string => `${splitVisible(text, Math.max(1, width - 1))[0] ?? ""}…`;
  const clipped = strip(render(long, { wrap: false }, 24, fakeRenderer(false, { truncate: clip })));
  assert.equal(clipped.length, 2);
  for (const line of clipped) {
    assert.equal(line.length, 24);
    assert.ok(line.endsWith("…"));
  }
});

test("layout stops at maxLines and ends with the truncation note", () => {
  const limits = { maxLines: 3, truncatedNote: "⋯ diff truncated" };
  const lines = renderPatch(parse(SAMPLE), config(), fakeRenderer(), PALETTE, 30, limits);
  assert.deepEqual(strip(lines), [
    "1 1   const a = 1;            ",
    "2   ▎ const b = 2;            ",
    "⋯ diff truncated",
  ]);
});

test("no truncation note when everything fits", () => {
  const lines = renderPatch(parse(SAMPLE), config(), fakeRenderer(), PALETTE, 30, {
    maxLines: 50,
    truncatedNote: "⋯ diff truncated",
  });
  assert.equal(lines.length, 5);
  assert.ok(!strip(lines).some((line) => line.includes("truncated")));
});

const MULTI_FILE = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,1 +1,1 @@",
  "-a",
  "+A",
  "diff --git a/b.ts b/b.ts",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1,1 +1,1 @@",
  "-b",
  "+B",
].join("\n");

const withFiles = (source: string, width = 40): string[] =>
  strip(
    renderPatch(parse(source), config(), fakeRenderer(), PALETTE, width, {
      maxLines: 200,
      fileHeader: (file) => `#${file}`,
    }),
  );

test("multi-file patches get one header per file instead of cross-file separators", () => {
  const lines = withFiles(MULTI_FILE);
  assert.equal(lines[0], "#a.ts");
  assert.equal(lines.filter((line) => line.startsWith("#")).length, 2);
  assert.ok(lines.includes("#b.ts"));
  assert.ok(!lines.some((line) => line.includes("unchanged")));
  // A blank row separates the files, so a stacked view does not run together.
  assert.equal(lines[lines.indexOf("#b.ts") - 1], "");
});

test("a second hunk of the same file keeps the skipped-lines separator", () => {
  const twoHunks = "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-a\n+A\n@@ -40,1 +40,1 @@\n-b\n+B";
  const lines = withFiles(twoHunks);
  assert.deepEqual(
    lines.filter((line) => line.startsWith("#")),
    ["#x.ts"],
  );
  assert.ok(lines.some((line) => line.includes("38 unchanged lines")));
});

/** 3 context rows and one 80-column replacement: fits one column, wraps in two. */
const LONG_LINES = [
  "@@ -1,3 +1,3 @@",
  " short one",
  `-${"a".repeat(80)}`,
  `+${"b".repeat(80)}`,
  " short two",
].join("\n");

/** Ten short replacement pairs: split halves the rows. */
const MANY_PAIRS = [
  "@@ -1,11 +1,11 @@",
  " context",
  ...Array.from({ length: 10 }, (_, i) => `-old ${i}\n+new ${i}`).join("\n").split("\n"),
].join("\n");

test("auto keeps one column when the lines only fit in the wide one", () => {
  const lines = strip(render(LONG_LINES, { style: "auto" }, 100));
  assert.ok(!lines.some((line) => line.includes("│")), "expected a stacked layout");
  assert.equal(lines.length, 4);
});

test("auto splits when two columns halve the wrapped rows", () => {
  const lines = strip(render(MANY_PAIRS, { style: "auto" }, 100));
  assert.ok(lines[0].includes("│"));
  assert.equal(lines.length, 11);
});

test("explicit split ignores the row estimate", () => {
  const lines = strip(render(LONG_LINES, { style: "split" }, 100));
  assert.ok(lines[0].includes("│"));
});

test("tab-indented rows never reach the painter raw and keep the column width", () => {
  const tabs = "@@ -1,2 +1,2 @@\n-\tif err != nil {\n+\tif err == nil {";
  const crlf = "@@ -1,2 +1,2 @@\r\n-ctx\r\n+ctx2\r\n";
  const lines = [...render(tabs, {}, 40), ...render(crlf, {}, 40)];

  // A raw tab would render wider than pi's three-column model and a CR would
  // send the cursor back to column 0, so neither may survive the parser.
  assert.ok(!lines.some((line) => line.includes("\t") || line.includes("\r")));
  for (const line of strip(lines)) assert.equal(line.length, 40);
});

test("the no-newline marker is painted under its row, without gutter or tint", () => {
  const source = "@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file";
  const stacked = strip(render(source, {}, 40));
  assert.equal(stacked.length, 3);
  assert.equal(stacked[2].trim(), "\\ No newline at end of file");
  assert.equal(stacked[2].length, 40);
  // Aligned with the code, not with the line numbers.
  assert.ok(stacked[2].startsWith("      \\"));

  const split = strip(render(source, { style: "split" }, 100));
  assert.equal(split.filter((line) => line.includes("No newline")).length, 1);
});
