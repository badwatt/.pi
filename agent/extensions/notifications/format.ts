/**
 * notifications — pure helpers for extracting, sanitizing, and formatting
 * notification content.
 *
 * This module has no dependency on Pi packages, so the logic can be unit-tested in
 * isolation with `node --test`.
 */

// ── Constants ──────────────────────────────────────────────────────────

const MAX_BODY_LENGTH = 200;
const NOTIFICATION_TITLE = "π";
const READY_TITLE = "Ready for input";

// ── Types ──────────────────────────────────────────────────────────────

export type MessageLike = { role?: string; content?: unknown };

export type NotificationContent = { title: string; body: string };

// ── Terminal safety ────────────────────────────────────────────────────

/** Strip C0/C1 control characters so values cannot break out of the OSC sequence. */
export const sanitizeTerminal = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, "");

/** Build an OSC 777 notification escape sequence (title/body are sanitized). */
export const buildOscNotification = (title: string, body: string): string =>
  `\x1b]777;notify;${sanitizeTerminal(title)};${sanitizeTerminal(body)}\x07`;

// ── Message extraction ─────────────────────────────────────────────────

const isTextPart = (part: unknown): part is { type: "text"; text: string } => {
  if (typeof part !== "object" || part === null) return false;
  const { type, text } = part as { type?: unknown; text?: unknown };
  return type === "text" && typeof text === "string";
};

/** Last assistant message as plain text, or `null` when there is none. */
export const extractLastAssistantText = (messages: ReadonlyArray<MessageLike>): string | null => {
  const lastAssistant = messages.findLast((message) => message?.role === "assistant");
  if (!lastAssistant) return null;

  const { content } = lastAssistant;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
  return text || null;
};

// ── Formatting ─────────────────────────────────────────────────────────

/**
 * Turn already-plain text into a notification title/body, collapsing whitespace
 * and truncating long bodies.
 */
export const buildNotificationContent = (plainText: string | null): NotificationContent => {
  const normalized = (plainText ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return { title: READY_TITLE, body: "" };
  const body =
    normalized.length > MAX_BODY_LENGTH ? `${normalized.slice(0, MAX_BODY_LENGTH - 1)}…` : normalized;
  return { title: NOTIFICATION_TITLE, body };
};
