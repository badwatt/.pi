/**
 * Notifications Extension
 *
 * Desktop notification when the agent finishes a turn.
 * Uses the OSC 777 escape sequence (Ghostty, iTerm2, WezTerm, rxvt-unicode, foot).
 *
 * Commands:
 *   /notifications        → toggle on/off
 *   /notifications on     → enable
 *   /notifications off    → disable
 *   /notifications status → show current state
 *
 * State persisted in extensionSettings.notifications (settings.json).
 * Text extraction and formatting live in `./format` (pure, unit-tested).
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, type AutocompleteItem, type MarkdownTheme } from "@mariozechner/pi-tui";
import { getExtSetting, setExtSetting } from "../../utils/extension-settings/index.js";
import {
  buildNotificationContent,
  buildOscNotification,
  extractLastAssistantText,
} from "./format.js";

const MARKDOWN_WIDTH = 80;

// ── Markdown → plain text ──────────────────────────────────────────────

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: () => "",
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: () => "",
  quote: (text) => text,
  quoteBorder: () => "",
  hr: () => "",
  listBullet: () => "",
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const toPlainText = (text: string): string =>
  new Markdown(text, 0, 0, plainMarkdownTheme).render(MARKDOWN_WIDTH).join("\n");

// ── OSC 777 notification ───────────────────────────────────────────────

const notify = (title: string, body: string): void => {
  if (!process.stdout.isTTY) return;
  process.stdout.write(buildOscNotification(title, body));
};

// ── /notifications command ─────────────────────────────────────────────

const SUBCOMMANDS: AutocompleteItem[] = [
  { value: "on", label: "on" },
  { value: "off", label: "off" },
  { value: "status", label: "status" },
];

// ── Extension entry ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on("agent_end", (event) => {
    if (!getExtSetting("notifications", true)) return;
    const text = extractLastAssistantText(event.messages ?? []);
    const { title, body } = buildNotificationContent(text ? toPlainText(text) : "");
    notify(title, body);
  });

  pi.registerCommand("notifications", {
    description: "Desktop notifications: /notifications [on|off|status] (no arg = toggle)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const filtered = SUBCOMMANDS.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const current = getExtSetting("notifications", true);
      const label = (value: boolean): string => (value ? "enabled" : "disabled");

      if (arg === "status") {
        ctx.ui.notify(`Notifications: ${current ? "on" : "off"}`, "info");
        return;
      }

      const next = arg === "on" ? true : arg === "off" ? false : !current;
      if (next !== current) setExtSetting("notifications", next);
      ctx.ui.notify(`Notifications ${label(next)}`, "info");
    },
  });
}
