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

test("split falls back to unified on narrow terminals", () => {
  const lines = strip(render(SAMPLE, { style: "split" }, 40));
  assert.equal(lines.length, 5);
  assert.ok(!lines[0].includes("│"));
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

test("long lines wrap or clip according to overflow", () => {
  const long = `@@ -1,1 +1,1 @@\n-${"a".repeat(30)}\n+${"b".repeat(30)}`;
  const wrapped = strip(render(long, {}, 24));
  const clipped = strip(render(long, { wrap: false }, 24));

  assert.equal(wrapped.length, 4);
  assert.equal(clipped.length, 2);
  for (const line of [...wrapped, ...clipped]) assert.equal(line.length, 24);
});

test("output is capped with a note when it exceeds maxLines", () => {
  const lines = capTest();
  assert.deepEqual(strip(lines).slice(-1), ["⋯ 3 more diff lines"]);
  assert.equal(lines.length, 3);
});

const capTest = (): string[] =>
  renderPatch(parse(SAMPLE), config(), fakeRenderer(), PALETTE, 30, { maxLines: 3 });
