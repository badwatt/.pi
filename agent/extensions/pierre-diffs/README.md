# pierre-diffs

Diff rendering for `edit` and `write` results in the visual language of
[`@pierre/diffs`](https://diffs.com) — stacked or split layout, change
indicators, tinted lines, line number gutters, word-level emphasis and hunk
separators.

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
| `diffStyle` | `auto` / `split` / `unified` | `unified` | `diffStyle` (stacked vs side-by-side) |
| `diffIndicators` | `bars` / `classic` / `none` | `bars` | `diffIndicators` |
| `lineDiffType` | `word-alt` / `word` / `word-line` / `char` / `none` | `word-alt` | `lineDiffType` |
| `overflow` | `wrap` / `scroll` | `wrap` | `overflow` |
| `hunkSeparators` | `line-info` / `line-info-basic` / `simple` / `metadata` / `none` | `line-info` | `hunkSeparators` |
| `lineNumbers` | `true` / `false` | `true` | `disableLineNumbers` (inverted) |
| `backgrounds` | `true` / `false` | `true` | `disableBackground` (inverted) |
| `syntaxHighlight` | `true` / `false` | `true` | — (Pi-specific) |

Notes:

- `auto` uses the split layout only when each column would still get 32 text
  columns (≈75 terminal columns for a one-digit diff), and `unified` otherwise.
  The check runs on every render, so resizing the terminal switches layout live.
- `split` forces two columns and only gives up when a column would get fewer
  than 8 text columns after gutters and markers.
- `word-alt` skips whitespace-only edits; `word` and `word-line` mark them too.
  Lines longer than 600 tokens fall back to whole-line emphasis.
- With `backgrounds: false` the change colours move to the text, so the syntax
  palette is dropped on changed lines to keep red/green legible.
- Long diffs are capped at 28 lines collapsed (`ctrl+o` expands) and 1200 lines
  expanded, with a `⋯ n more diff lines` note.

Resulting `settings.json` fragment:

```json
{
  "extensionSettings": {
    "pierre-diffs": {
      "enabled": true,
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
2. `patch.ts` parses the unified patch into hunks with both line numbers.
3. `words.ts` pairs deletion/addition runs and computes the changed character
   ranges (`word-alt`/`word`/`char`), using a capped LCS over tokens.
4. `render.ts` lays the rows out (unified or two columns), then paints gutters,
   markers, line backgrounds, syntax colours and emphasis for a given width.
5. `ansi.ts` overlays the emphasis background on already-highlighted text and
   restores the line background, so fg codes from the highlighter survive.

Parsing and layout are cached per tool call and invalidated by width, options,
theme or language, so re-renders (scroll, resize, spinner frames) reuse the
previous output instead of recomputing it.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension wiring: tool renderers, caches, palette, `/diffs` command |
| `options.ts` | Option schema (defaults, validation, settings list) + typed config |
| `patch.ts` | Unified diff parser, added-file model, gutter width |
| `words.ts` | Intra-line diff ranges (LCS over tokens) |
| `ansi.ts` | Background overlay over highlighted text |
| `render.ts` | Layout + painting. No Pi imports, fully unit tested |
| `*.test.ts` | Unit tests for the pure modules |

## Tests

```sh
node --test agent/extensions/pierre-diffs/*.test.ts
```
