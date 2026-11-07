# pierre-diffs

Diff rendering in the visual language of [`@pierre/diffs`](https://diffs.com) —
stacked or split layout, change indicators, tinted lines, line number gutters,
word-level emphasis and hunk separators.

Two sources feed it:

- **`edit` and `write`** are re-registered, so their patch is drawn inside the
tool row (the built-in renderer is what this replaces).
- **Anything else that changes files** — `bash` running a python heredoc, `sed`,
a formatter, `ctx_edit`, an MCP tool — gets a diff block appended to the
transcript after the tool result, built from a git snapshot of the worktree.

**This is a native port, not a wrapper.** `@pierre/diffs` renders HTML into
shadow DOM with CSS grid, which a terminal cannot do. What is ported is its
layout model and its option vocabulary, so the settings below mean the same
thing they mean on the web. Syntax colours come from the active Pi theme
(`highlightCode`), not from Shiki.

## Commands

| Command | Description |
|---------|-------------|
| `/diffs` | Settings list: layout, indicators, word diff, wrapping, separators, gutters, backgrounds |

Changes apply immediately and are persisted in `extensionSettings["pierre-diffs"]`
in `settings.json`. Every option has a default, so the entry is only created on
the first change.

## Options

| Key | Values | Default | Mirrors `@pierre/diffs` |
|-----|--------|---------|-------------------------|
| `enabled` | `true` / `false` | `true` | — (plain coloured patch when `false`) |
| `toolDiffs` | `true` / `false` | `true` | — (diff files changed by any tool, not just `edit`/`write`) |
| `diffStyle` | `auto` / `split` / `unified` | `unified` | `diffStyle` (stacked vs side-by-side) |
| `diffIndicators` | `bars` / `classic` / `none` | `bars` | `diffIndicators` |
| `lineDiffType` | `word-alt` / `word` / `word-line` / `char` / `none` | `word-alt` | `lineDiffType` |
| `overflow` | `wrap` / `scroll` | `wrap` | `overflow` |
| `hunkSeparators` | `line-info` / `line-info-basic` / `simple` / `metadata` / `none` | `line-info` | `hunkSeparators` |
| `lineNumbers` | `true` / `false` | `true` | `disableLineNumbers` (inverted) |
| `backgrounds` | `true` / `false` | `true` | `disableBackground` (inverted) |
| `syntaxHighlight` | `true` / `false` | `true` | — (Pi-specific) |

Notes:

- `auto` picks split only when both columns keep ≥32 text columns **and** the
  two columns need fewer wrapped rows than one column; a tie keeps the single
  column, which is the simpler read. Rows are counted with the real line
  lengths, so a diff whose lines only fit the wide column stays stacked instead
  of wrapping twice, while a diff that fits two columns earns the side-by-side
  view however wide the terminal is. The estimate is one pass over the rows
  (~1 ms for 1200 rows) and runs per render, so resizing switches layout live.
- `split` forces two columns and only gives up when a column would get fewer
  than 8 text columns after gutters and markers.
- `word-alt` skips whitespace-only edits; `word` and `word-line` mark them too.
  Lines longer than 600 tokens fall back to whole-line emphasis.
- A tool diff block gets syntax colours only when every file in it shares one
  language; a mixed patch stays in change colours rather than colouring half
  the block with the wrong grammar.
- With `backgrounds: false` the change colours move to the text, so the syntax
  palette is dropped on changed lines to keep red/green legible.
- A diff is never collapsed: `edit` and tool diff blocks show the whole patch up
  to a 1200-row ceiling, which is where a `⋯ diff truncated` row can appear
  (Pi's own `edit` renderer has no ceiling at all). `write` is the exception: it
  previews 28 lines of a whole file, with `⋯ more diff lines · ctrl+o` until
  expanded to the same ceiling.
- A tool diff block is per repository and per call. Files changed by `edit` and
  `write` are not repeated there: those already draw their own patch.
- A change with no text to draw (a mode change, a rename, a binary file) still
  gets a block, reading `no text diff (mode, rename or binary)` instead of
  staying silent about a file the tool did touch.
- Diffs written as Markdown in a message (a ```` ```diff ```` fence) are **not**
  affected. Pi renders message Markdown itself and extensions only get
  `registerMarkdownTransformer`, which returns Markdown, so the pierre layout
  cannot be injected there.

Resulting `settings.json` fragment:

```json
{
  "extensionSettings": {
    "pierre-diffs": {
      "enabled": true,
      "toolDiffs": true,
      "diffStyle": "auto",
      "diffIndicators": "bars",
      "lineDiffType": "word-alt",
      "overflow": "wrap",
      "hunkSeparators": "line-info",
      "lineNumbers": true,
      "backgrounds": true,
      "syntaxHighlight": true
    }
  }
}
```

## How it works

1. `edit` and `write` are re-registered with the built-in definitions, replacing
   only `renderCall`/`renderResult` (execution, schemas and prompt metadata are
   inherited). `edit` renders `details.patch`; `write` renders the new file as an
   all-additions diff.
2. `snapshot.ts` watches the worktree for every other tool: `tool_call` makes
   sure a snapshot exists, `tool_result` takes another one, asks git for the
   patch between the two trees and appends a `pierre-diff` custom entry (which
   does not reach the model). Read-only tools are skipped; nested calls are
   skipped because the parent call reports them. The snapshot is written through
   a temporary index, so the worktree, `.git/index` and `HEAD` are untouched.
3. `patch.ts` parses the unified patch into hunks with both line numbers and the
   file each hunk belongs to, and normalises row text the way the TUI measures
   it: tabs become three columns and a trailing `\r` is dropped, so the padding
   math, the intra-line ranges and the terminal agree.
4. `words.ts` pairs deletion/addition runs and computes the changed character
   ranges (`word-alt`/`word`/`char`), using a capped LCS over tokens.
5. `render.ts` lays the rows out (unified or two columns), then paints gutters,
   markers, line backgrounds, syntax colours and emphasis for a given width. A
   multi-file patch gets one header per file and no cross-file hunk separator,
   whose "unchanged lines" count would be meaningless.
6. `ansi.ts` overlays the emphasis background on already-highlighted text and
   restores the line background, so fg codes from the highlighter survive.

### What the worktree watcher cannot see

- **Only git repositories.** Outside one there is no diff; the tool output is
  shown as usual. A change made in another repository than the session's (after
  a `cd`) is not snapshotted either. Whether a directory is a worktree is
  probed once per session, so a `git init` mid-session needs `/reload`. The
  snapshot itself needs a POSIX `env` binary to point git at the temporary
  index.
- **Parallel tool calls.** Changes are reported once, but with two writes in
  flight they may be attributed to the call that finished first.
- **Binary-only changes.** `git` reports them without hunks, so nothing is
  drawn.
- **Cost.** One `git add -A` over the dirty files after each watched call:
  4–11 ms on the repositories measured here, bounded by a 5 s timeout. A
  repository that hits that timeout is left unwatched for the rest of the
  session (Esc does not count as a timeout). The snapshot index lives in the
  temp directory and is reused across calls, so only files whose stat data
  changed are re-read.

## Performance

Pi calls `Component.render(width)` on every TUI frame (~12×/s) for each visible
tool row, but calls `renderResult` only when a row changes. The extension is
built around that split:

| Path | Cost | Why |
|------|------|-----|
| `render(width)` (per frame) | ~microseconds | `modelFor` + `linesFor` are two cache lookups with field comparisons — no string building, no allocation, no parsing |
| `renderResult` (per change) | negligible | Only resolves the config (memoised per options object) and captures the cache key |
| cold render, 200 rows | ~11ms | One-off per (width, options, theme, language): tokenise, wrap, paint |
| cold render, 1200 rows | ~47ms | Same, paid once when you expand a very large diff |
| `write` preview (28 rows) | ~2.6ms | Layout stops at the cap instead of painting 1200 rows and slicing |
| worktree snapshot | 4–11ms per watched call | One `git add -A` over the dirty files through a warm temporary index |
| `auto` layout estimate | ~1ms per 1200 rows | One arithmetic pass over the pairs, once per cached render |

Other guards:

- Syntax highlighting is cached by theme, language and line text, so resizing
  the terminal or toggling an option re-uses the previous tokenisation.
- Lines longer than 1000 characters (minified or generated code) skip
  highlighting: one such line costs more than 30 normal ones.
- `write` never splits the whole file: `addedFilePatch` materialises at most 1200
  rows and counts the rest with a single `indexOf` pass, and the `write` header
  reuses a one-entry line-count memo.
- Caches are bounded (`64` tool calls, `1500` highlighted lines) and keyed by
  tool call, so they never grow with session length.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension wiring: tool renderers, caches, palette, `/diffs` command |
| `options.ts` | Option schema (defaults, validation, settings list) + typed config |
| `patch.ts` | Unified diff parser (both line numbers, file names), added-file model, gutter width |
| `snapshot.ts` | Git worktree snapshots + tree-to-tree patch for non-`edit` tools |
| `words.ts` | Intra-line diff ranges (LCS over tokens) |
| `ansi.ts` | Background overlay over highlighted text |
| `render.ts` | Layout + painting. No Pi imports, fully unit tested |
| `*.test.ts` | Unit tests for the pure modules |

## Tests

```sh
node --test agent/extensions/pierre-diffs/*.test.ts
```
