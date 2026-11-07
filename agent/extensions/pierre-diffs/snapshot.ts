/**
 * Worktree snapshots for tools that mutate files outside `edit`/`write`.
 *
 * A shell command, a formatter, `ctx_edit` or an MCP tool can rewrite the
 * worktree without telling the UI. To show those changes the extension watches
 * the repository instead of the tool: a snapshot of the worktree is taken
 * before the first mutating call and refreshed after every call, and git
 * produces the patch between two snapshots.
 *
 * A snapshot is a tree object written through a temporary index that lives in
 * the OS temp directory. It is kept for the whole session, so `git add -A`
 * re-reads only files whose stat data changed: 4–11 ms on real repositories.
 * The worktree, the real index and HEAD are never modified; the blobs that
 * `git add` writes are the same objects a later commit would create, and git
 * prunes them like any other unreferenced object.
 *
 * Attribution is per call, and the queue is per repository: with parallel tool
 * calls the changes are reported once, but possibly under the call that
 * finished first. A call that cannot be snapshotted (no repository, timeout,
 * unmerged index) yields no patch instead of a wrong one.
 */

import { createHash } from "node:crypto";
import { access, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
  truncated?: boolean;
}

export interface CommandOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
  maxBuffer?: number;
}

export type RunCommand<TResult extends CommandResult = CommandResult> = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<TResult>;

export interface Snapshotter {
  /** Take the baseline if this repository has none yet. Call before a tool runs. */
  prime(cwd: string, signal?: AbortSignal): Promise<void>;
  /** Patch from the previous snapshot to the current worktree, then rebaseline. */
  advance(cwd: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Forget the baselines, so the next call snapshots from scratch. */
  reset(): Promise<void>;
  /** Drop the temporary indexes. */
  dispose(): Promise<void>;
}

interface Repo {
  root: string;
  gitDir: string;
  /** Temporary index: mirrors the worktree, never the user's `.git/index`. */
  index: string;
  /** Tree of the last snapshot, absent until the first one succeeds. */
  tree?: string;
  /** Serialises snapshots: git takes a lock on the temporary index. */
  queue: Promise<unknown>;
  /** A snapshot that timed out once would time out on every later call. */
  disabled?: boolean;
}

const GIT_TIMEOUT_MS = 5000;
const PATCH_TIMEOUT_MS = 10_000;
/** A patch is stored in the session, so it is capped; a cut patch still parses. */
const PATCH_MAX_BYTES = 512 * 1024;

/** Per repository and per process: two sessions must not share one lock file. */
const indexName = (root: string): string =>
  `pi-pierre-${createHash("sha1").update(root).digest("hex").slice(0, 16)}-${process.pid}.index`;

export const createSnapshotter = (run: RunCommand, options: { dir?: string } = {}): Snapshotter => {
  const roots = new Map<string, string | null>();
  /** `null` marks a directory that is not a worktree, so it is probed once. */
  const repos = new Map<string, Repo | null>();
  const indexDir = options.dir ?? tmpdir();

  const git = (cwd: string, args: string[], extra: CommandOptions = {}): Promise<CommandResult> =>
    run("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS, ...extra });

  const rootOf = async (cwd: string): Promise<string | undefined> => {
    const cached = roots.get(cwd);
    if (cached !== undefined) return cached ?? undefined;

    const result = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
    // A killed call (timeout, Esc) says nothing about the directory.
    if (result === undefined || result.killed) return undefined;

    const root = result.code === 0 ? result.stdout.trim() : "";
    roots.set(cwd, root || null);
    return root || undefined;
  };

  const repoOf = async (cwd: string, signal?: AbortSignal): Promise<Repo | undefined> => {
    const root = await rootOf(cwd);
    if (!root) return undefined;

    const cached = repos.get(root);
    if (cached !== undefined) return cached ?? undefined;

    const notAWorktree = (): undefined => {
      repos.set(root, null);
      return undefined;
    };

    const inside = await git(root, ["rev-parse", "--is-inside-work-tree"], { signal }).catch(() => undefined);
    if (inside === undefined || inside.killed) return undefined;
    if (inside.code !== 0 || inside.stdout.trim() !== "true") return notAWorktree();

    const dir = await git(root, ["rev-parse", "--git-dir"], { signal }).catch(() => undefined);
    if (dir === undefined || dir.killed) return undefined;
    if (dir.code !== 0) return notAWorktree();

    const repo: Repo = {
      root,
      gitDir: resolve(root, dir.stdout.trim()),
      index: join(indexDir, indexName(root)),
      queue: Promise.resolve(),
    };
    repos.set(root, repo);
    return repo;
  };

  const forget = async (repo: Repo): Promise<void> => {
    await rm(repo.index, { force: true }).catch(() => undefined);
    await rm(`${repo.index}.lock`, { force: true }).catch(() => undefined);
  };

  /** Write the current worktree as a tree object. Must run inside the queue. */
  const capture = async (repo: Repo, signal?: AbortSignal): Promise<string | undefined> => {
    if (repo.disabled) return undefined;
    const env = `GIT_INDEX_FILE=${repo.index}`;
    const run2 = (args: string[]): Promise<CommandResult> =>
      run("env", [env, "git", "-C", repo.root, ...args], { timeout: GIT_TIMEOUT_MS, signal });

    try {
      // Seeding from the real index brings its stat cache along, so the first
      // `add` only reads files that are already dirty. Later snapshots reuse the
      // temporary index, whose stat data is fresher than the user's.
      const seeded = await access(repo.index).then(() => true, () => false);
      if (!seeded) await copyFile(join(repo.gitDir, "index"), repo.index).catch(() => undefined);
      const staged = await run2(["add", "-A"]);
      // Esc kills the snapshot too; only a real timeout means the repository is
      // too slow to watch, and then it stays off instead of stalling every call.
      if (staged.killed && !signal?.aborted) repo.disabled = true;
      if (staged.code !== 0 || staged.killed) throw new Error(staged.stderr);
      const written = await run2(["write-tree"]);
      if (written.code !== 0 || written.killed) throw new Error(written.stderr);
      const tree = written.stdout.trim();
      return tree.length > 0 ? tree : undefined;
    } catch {
      // A half-written index would poison every later snapshot.
      await forget(repo);
      return undefined;
    }
  };

  const patchBetween = async (repo: Repo, before: string, after: string, signal?: AbortSignal): Promise<string | undefined> => {
    const result = await run(
      "git",
      [
        "-C",
        repo.root,
        // Verbatim paths in the headers: quoted octal escapes would end up in
        // the file labels.
        "-c",
        "core.quotePath=false",
        "diff-tree",
        "-r",
        "-p",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "-U3",
        before,
        after,
      ],
      { timeout: PATCH_TIMEOUT_MS, maxBuffer: PATCH_MAX_BYTES, signal },
    ).catch(() => undefined);
    if (!result) return undefined;
    // A patch cut at maxBuffer still parses up to the cut; the renderer's row
    // cap is what the reader sees anyway.
    if (result.code !== 0 && !result.truncated) return undefined;
    return result.stdout.trim().length > 0 ? result.stdout : undefined;
  };

  const liveRepos = (): Repo[] => [...repos.values()].filter((repo): repo is Repo => repo !== null);

  const serialised = <T>(repo: Repo, task: () => Promise<T>): Promise<T> => {
    const result = repo.queue.then(task, task);
    repo.queue = result.catch(() => undefined);
    return result;
  };

  return {
    async prime(cwd, signal) {
      const repo = await repoOf(cwd, signal);
      if (!repo) return;
      await serialised(repo, async () => {
        if (repo.tree === undefined) repo.tree = await capture(repo, signal);
      });
    },

    async advance(cwd, signal) {
      const repo = await repoOf(cwd, signal);
      if (!repo) return undefined;
      return serialised(repo, async () => {
        const before = repo.tree;
        const after = await capture(repo, signal);
        repo.tree = after;
        if (!before || !after || before === after) return undefined;
        return patchBetween(repo, before, after, signal);
      });
    },

    async reset() {
      await Promise.all(
        liveRepos().map((repo) =>
          serialised(repo, async () => {
            repo.tree = undefined;
          }),
        ),
      );
    },

    async dispose() {
      await Promise.all(
        liveRepos().map(async (repo) => {
          await repo.queue;
          await forget(repo);
        }),
      );
      repos.clear();
    },
  };
};
