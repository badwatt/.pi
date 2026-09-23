# notifications

Desktop notification when the agent finishes a turn. Shows a snippet of the agent's last response as the notification body, stripped of Markdown formatting.

Uses the **OSC 777** escape sequence — no external dependencies needed.

### Supported terminals

| Terminal | Works |
|----------|-------|
| Ghostty | ✅ |
| iTerm2 | ✅ |
| WezTerm | ✅ |
| foot | ✅ |
| rxvt-unicode | ✅ |
| Kitty | ❌ (uses OSC 99) |
| Terminal.app | ❌ |
| Windows Terminal | ❌ |
| Alacritty | ❌ |

## Commands

| Command | Description |
|---------|-------------|
| `/notifications` | Toggle on/off |
| `/notifications on` | Enable |
| `/notifications off` | Disable |
| `/notifications status` | Show current state |

Default: enabled. State persisted as `extensionSettings.notifications` in `settings.json`.

## How it works

1. On `agent_end`, extracts the last assistant message text.
2. Strips Markdown formatting → plain text.
3. Normalizes whitespace, truncates to 200 chars (with `…`).
4. Sends via OSC 777: title `"π"`, body = the snippet.
5. If no text found: title `"Ready for input"`, empty body.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension wiring: `agent_end` handler, `/notifications` command, Markdown→plain text |
| `format.ts` | Pure helpers (terminal sanitizing, OSC 777, text extraction, formatting). No Pi dependencies. |
| `format.test.ts` | Unit tests for `format.ts` |

## Tests

```sh
node --test agent/extensions/notifications/format.test.ts
```