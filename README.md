# .pi — Pi Coding Agent Configuration

User extensions, skills, and settings for [pi](https://github.com/badlogic/pi-mono).

## Installation

```sh
npm i -g @earendil-works/pi-coding-agent
```

## Extensions

| Extension | Description | Commands |
|-----------|-------------|----------|
| [custom-footer](agent/extensions/custom-footer/) | TUI footer: model, token stats, context %, elapsed, CWD, git branch, TPS, query time | — |
| [notifications](agent/extensions/notifications/) | Desktop notifications via OSC 777 when agent finishes. Shows response snippet as body. | `/notifications [on\|off\|status]` |
| [ollama](agent/extensions/ollama/) | Local Ollama + Ollama Cloud provider + `ollama_web_search` / `ollama_web_fetch` tools | `/ollama [status\|sync]` |
| [ui](agent/extensions/ui/) | Pi Pane — custom TUI layout with pane editor, message patches, startup header | — |
| [extension-settings](agent/utils/extension-settings/) | Shared utility module for persisting extension state in `settings.json` | — |

## Packages

Installed from [`settings.json`](agent/settings.json) `packages` array:

| Package | Source |
|---------|--------|
| `@ifi/pi-plan` | npm |
| `@lpirito/pi-diffloop` | npm |
| `pi-ask-mode` | npm |
| `pi-lean-ctx` | npm |
| `pi-mcp-adapter` | npm |
| `pi-secret-guard` | npm |
| `pi-subagents` | npm |
| `pi-tool-display` | npm |

## Settings

### General

| Key | Type | Default | Current | Description |
|-----|------|---------|---------|-------------|
| `defaultProvider` | `string` | — | `ollama-cloud` | Default model provider |
| `defaultModel` | `string` | — | `glm-5.2` | Default model ID |
| `theme` | `string` | — | `catppuccin-mocha` | TUI theme |
| `npmCommand` | `string[]` | — | `pnpm` | Preferred npm client command |
| `quietStartup` | `boolean` | `false` | `false` | Suppress startup messages |
| `hideThinkingBlock` | `boolean` | `false` | `false` | Hide thinking blocks in output |
| `defaultThinkingLevel` | `string` | `medium` | `medium` | Default thinking level |
| `enableInstallTelemetry` | `boolean` | `true` | `false` | Telemetry on package install |
| `terminal.showTerminalProgress` | `boolean` | `false` | `true` | Show terminal progress indicator |

### Extension settings

Persisted in [`settings.json`](agent/settings.json) under `extensionSettings`:

| Key | Type | Default | Current | Description |
|-----|------|---------|---------|-------------|
| `notifications` | `boolean` | `true` | `true` | Desktop notifications enabled |
