/**
 * Unit tests for pierre-diffs/patch.ts (pure helpers).
 *
 * Run with: node --test agent/extensions/pierre-diffs/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addedFilePatch, lineNumberWidth, parsePatch } from "./patch.ts";

const PATCH = [
  "--- /tmp/a.ts",
  "+++ /tmp/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "@@ -20,2 +21,1 @@",
  "-gone();",
  " kept();",
  "\\ No newline at end of file",
].join("\n");

test("parsePatch tracks both line numbers", () => {
  const { hunks, additions, deletions } = parsePatch(PATCH);
  assert.equal(hunks.length, 2);
  assert.equal(additions, 2);
  assert.equal(deletions, 2);

  assert.deepEqual(hunks[0].rows, [
    { kind: "context", oldNo: 1, newNo: 1, text: "const a = 1;" },
    { kind: "deletion", oldNo: 2, text: "const b = 2;" },
    { kind: "addition", newNo: 2, text: "const b = 3;" },
    { kind: "addition", newNo: 3, text: "const c = 4;" },
    { kind: "context", oldNo: 3, newNo: 4, text: "const d = 5;" },
  ]);
  assert.deepEqual(hunks[1].rows, [
    { kind: "deletion", oldNo: 20, text: "gone();" },
    { kind: "context", oldNo: 21, newNo: 21, text: "kept();" },
  ]);
});

test("parsePatch accepts git hunks without counts", () => {
  const { hunks } = parsePatch("@@ -7 +9 @@\n-old\n+new");
  assert.equal(hunks[0].oldStart, 7);
  assert.equal(hunks[0].oldCount, 1);
  assert.equal(hunks[0].newStart, 9);
  assert.equal(hunks[0].newCount, 1);
  assert.deepEqual(hunks[0].rows[0], { kind: "deletion", oldNo: 7, text: "old" });
});

test("parsePatch ignores preamble and stops at non-diff lines", () => {
  const parsed = parsePatch("random text\n@@ -1,1 +1,1 @@\n-a\n+b\nnot a diff line\n+c");
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].rows.length, 2);
});

test("parsePatch keeps empty context lines and deletion of a dashed line", () => {
  const parsed = parsePatch("@@ -1,2 +1,2 @@\n plain\n---old\n+++new");
  assert.deepEqual(parsed.hunks[0].rows, [
    { kind: "context", oldNo: 1, newNo: 1, text: "plain" },
    { kind: "deletion", oldNo: 2, text: "--old" },
    { kind: "addition", newNo: 2, text: "++new" },
  ]);
  assert.equal(parsed.hunks.length, 1);
});

test("parsePatch on an empty patch yields nothing", () => {
  assert.deepEqual(parsePatch(""), { hunks: [], additions: 0, deletions: 0 });
});

test("addedFilePatch models a new file and respects the row limit", () => {
  const full = addedFilePatch("one\ntwo\nthree\n", 10);
  assert.equal(full.additions, 3);
  assert.deepEqual(
    full.hunks[0].rows.map((row) => row.newNo),
    [1, 2, 3],
  );
  assert.equal(full.hunks[0].rows[0].kind, "addition");

  const limited = addedFilePatch("one\ntwo\nthree\n", 2);
  assert.equal(limited.additions, 3);
  assert.equal(limited.hunks[0].rows.length, 2);
});

test("addedFilePatch on empty content has no rows", () => {
  const parsed = addedFilePatch("", 10);
  assert.equal(parsed.additions, 0);
  assert.deepEqual(parsed.hunks[0].rows, []);
});

test("lineNumberWidth uses the widest number present", () => {
  assert.equal(lineNumberWidth(parsePatch(PATCH)), 2);
  assert.equal(lineNumberWidth(parsePatch("@@ -98,1 +99,1 @@\n-a\n+b")), 2);
  assert.equal(lineNumberWidth({ hunks: [], additions: 0, deletions: 0 }), 1);
});
