/**
 * Tests for pierre-diffs/snapshot.ts against real git repositories.
 *
 * Run with: node --test agent/extensions/pierre-diffs/*.test.ts
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSnapshotter, type RunCommand } from "./snapshot.ts";

const run: RunCommand = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: options?.cwd, timeout: options?.timeout, maxBuffer: 8 * 1024 * 1024, signal: options?.signal },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        // pi reports abort, timeout and maxBuffer the same way.
        const killed = Boolean(error?.killed) || error?.name === "AbortError";
        resolve({ stdout: String(stdout), stderr: String(stderr), code, killed });
      },
    );
  });

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
};

/** A committed repository plus an isolated snapshot directory, removed by `cleanup`. */
const makeRepo = async (): Promise<{ dir: string; state: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "pierre-snap-"));
  const state = await mkdtemp(join(tmpdir(), "pierre-state-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return {
    dir,
    state,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    },
  };
};

test("advance reports a change made outside edit/write", async () => {
  const repo = await makeRepo();
  const snapshots = createSnapshotter(run, { dir: repo.state });
  try {
    await snapshots.prime(repo.dir);
    await writeFile(join(repo.dir, "a.txt"), "one\nTWO\nthree\n");

    const patch = await snapshots.advance(repo.dir);
    assert.ok(patch, "expected a patch");
    assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt/m);
    assert.match(patch, /^-two$/m);
    assert.match(patch, /^\+TWO$/m);
  } finally {
    await snapshots.dispose();
    await repo.cleanup();
  }
});

test("advance reports a brand new file as additions", async () => {
  const repo = await makeRepo();
  const snapshots = createSnapshotter(run, { dir: repo.state });
  try {
    await snapshots.prime(repo.dir);
    await writeFile(join(repo.dir, "nuevo.txt"), "hola\nmundo\n");

    const patch = await snapshots.advance(repo.dir);
    assert.ok(patch);
    assert.match(patch, /^new file mode /m);
    assert.match(patch, /^\+hola$/m);
    assert.match(patch, /^\+mundo$/m);
  } finally {
    await snapshots.dispose();
    await repo.cleanup();
  }
});

test("advance reports a non-ASCII file name verbatim", async () => {
  const repo = await makeRepo();
  const snapshots = createSnapshotter(run, { dir: repo.state });
  try {
    await snapshots.prime(repo.dir);
    await writeFile(join(repo.dir, "café.txt"), "hola\n");

    const patch = await snapshots.advance(repo.dir);
    assert.ok(patch);
    // git would otherwise emit `"caf\303\251.txt"` and the label would show escapes.
    assert.match(patch, /\+\+\+ b\/café\.txt/);
  } finally {
    await snapshots.dispose();
    await repo.cleanup();
  }
});

test("advance reports a deleted file by name", async () => {
  const repo = await makeRepo();
  const snapshots = createSnapshotter(run, { dir: repo.state });
  try {
    await snapshots.prime(repo.dir);
    git(repo.dir, "rm", "-q", "a.txt");

    const patch = await snapshots.advance(repo.dir);
    assert.ok(patch);
    assert.match(patch, /^deleted file mode /m);
    assert.match(patch, /^--- a\/a\.txt$/m);
  } finally {
    await snapshots.dispose();
    await repo.cleanup();
  }
});

test("advance without changes yields nothing and keeps the baseline", async () => {
  const repo = await makeRepo();
  const snapshots = createSnapshotter(run, { dir: repo.state });
  try {
    await snapshots.prime(repo.dir);
    assert.equal(await snapshots.advance(repo.dir), undefined);

    await writeFile(join(repo.dir, "a.txt"), "one\ntwo\nthree\nfour\n");
    const patch = await snapshots.advance(repo.dir);
    assert.ok(patch);
    assert.match(patch, /^\+four$/m);
  } finally {
    await snapshots.dispose();
    await repo.cleanup();
  }
});

test("a directory that is not a repository yields nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pierre-nogit-"));
  const snapshots = createSnapshotter(run, { dir });
  try {
    await snapshots.prime(dir);
    assert.equal(await snapshots.advance(dir), undefined);
  } finally {
    await snapshots.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real index is never modified", async () => {
  const repo = await makeRepo();
  const snapshots = createSnapshotter(run, { dir: repo.state });
  try {
    await writeFile(join(repo.dir, "a.txt"), "one\ndirty\nthree\n");
    const before = execFileSync("git", ["-C", repo.dir, "status", "--porcelain"], { encoding: "utf8" });

    await snapshots.prime(repo.dir);
    await snapshots.advance(repo.dir);

    const after = execFileSync("git", ["-C", repo.dir, "status", "--porcelain"], { encoding: "utf8" });
    assert.equal(after, before, "snapshotting must not stage anything");
  } finally {
    await snapshots.dispose();
    await repo.cleanup();
  }
});

test("reset drops the baseline so old changes are not reported again", async () => {
  const repo = await makeRepo();
  const snapshots = createSnapshotter(run, { dir: repo.state });
  try {
    await snapshots.prime(repo.dir);
    await writeFile(join(repo.dir, "a.txt"), "one\nTWO\nthree\n");
    assert.ok(await snapshots.advance(repo.dir), "the first change is reported");

    await snapshots.reset();
    await snapshots.prime(repo.dir);
    assert.equal(await snapshots.advance(repo.dir), undefined, "nothing new to report");

    await writeFile(join(repo.dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    const patch = await snapshots.advance(repo.dir);
    assert.ok(patch);
    assert.match(patch, /^\+four$/m);
  } finally {
    await snapshots.dispose();
    await repo.cleanup();
  }
});

test("an aborted probe does not poison the directory", async () => {
  const repo = await makeRepo();
  const snapshots = createSnapshotter(run, { dir: repo.state });
  const aborted = AbortSignal.abort();
  try {
    // Prime and advance with a dead signal: every git call is cut short.
    await snapshots.prime(repo.dir, aborted);
    await snapshots.advance(repo.dir, aborted);

    await snapshots.prime(repo.dir);
    await writeFile(join(repo.dir, "a.txt"), "one\ntwo\nthree\nfour\n");
    const patch = await snapshots.advance(repo.dir);
    assert.ok(patch, "the repository is still watched after an aborted call");
    assert.match(patch, /^\+four$/m);
  } finally {
    await snapshots.dispose();
    await repo.cleanup();
  }
});
