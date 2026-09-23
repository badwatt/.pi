# custom-footer

Custom TUI status bar with real-time session stats. Replaces the default footer on session start.

## Displayed info

| Segment | Description |
|---------|-------------|
| `◆ provider/model` | Current model + thinking level indicator (◆ color: high=warning, medium=accent, low=dim, off=muted) |
| `in/out ctx%` | Token counts (input/output) + context window usage % (color: >75%=error, >50%=warning, else=success) |
| `⏱ elapsed` | Time since session start (auto-updates every 30s) |
| `⌂ cwd` | Last 2 segments of working directory |
| `⎇ branch` | Current git branch (if any) |
| `tok/s` | Output tokens per second from last agent turn |
| `query time` | Wall-clock duration of last agent turn |

## Commands

None. The footer installs automatically on session start in interactive (`tui`) mode.

## Events tracked

- `session_start` / `session_switch` — resets counters, installs footer
- `agent_start` / `agent_end` — tracks TPS + query duration
- `turn_end` — accumulates token usage
- `session_tree` / `session_fork` — recalculates totals
- `session_shutdown` — disposes the footer (idempotent)

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension wiring: event handlers, footer lifecycle |
| `format.ts` | Pure helpers (formatting, usage aggregation, segment rendering). No runtime Pi dependencies. |
| `format.test.ts` | Unit tests for `format.ts` |

## Tests

```sh
node --test agent/extensions/custom-footer/format.test.ts
```
