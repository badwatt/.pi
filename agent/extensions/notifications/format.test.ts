/**
 * Unit tests for notifications/format.ts (pure helpers).
 *
 * Run with: node --test agent/extensions/notifications/format.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNotificationContent,
  buildOscNotification,
  extractLastAssistantText,
  sanitizeTerminal,
} from "./format.ts";

test("sanitizeTerminal strips control characters", () => {
  assert.equal(sanitizeTerminal("a\x00b\x1fc\x7fd"), "abcd");
  assert.equal(sanitizeTerminal("plain"), "plain");
});

test("buildOscNotification wraps and sanitizes", () => {
  assert.equal(buildOscNotification("π", "hi"), "\x1b]777;notify;π;hi\x07");
  assert.equal(buildOscNotification("a\x07b", "b\x1bdy"), "\x1b]777;notify;ab;bdy\x07");
});

test("extractLastAssistantText returns null without an assistant message", () => {
  assert.equal(extractLastAssistantText([]), null);
  assert.equal(extractLastAssistantText([{ role: "user", content: "hi" }]), null);
});

test("extractLastAssistantText handles string content", () => {
  assert.equal(extractLastAssistantText([{ role: "assistant", content: "  hello  " }]), "hello");
  assert.equal(extractLastAssistantText([{ role: "assistant", content: "   " }]), null);
});

test("extractLastAssistantText handles array content", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "line 1" },
        { type: "tool_use", name: "bash" },
        { type: "text", text: "line 2" },
      ],
    },
  ];
  assert.equal(extractLastAssistantText(messages), "line 1\nline 2");
  assert.equal(extractLastAssistantText([{ role: "assistant", content: [{ type: "text", text: 42 }] }]), null);
});

test("extractLastAssistantText picks the last assistant message", () => {
  const messages = [
    { role: "assistant", content: "first" },
    { role: "user", content: "again" },
    { role: "assistant", content: "second" },
  ];
  assert.equal(extractLastAssistantText(messages), "second");
});

test("buildNotificationContent collapses whitespace and handles empty input", () => {
  assert.deepEqual(buildNotificationContent(null), { title: "Ready for input", body: "" });
  assert.deepEqual(buildNotificationContent("   \n  "), { title: "Ready for input", body: "" });
  assert.deepEqual(buildNotificationContent("hello   world\n\nthere"), { title: "π", body: "hello world there" });
});

test("buildNotificationContent truncates long bodies to 200 chars", () => {
  const long = "x".repeat(250);
  const { body } = buildNotificationContent(long);
  assert.equal(body.length, 200);
  assert.equal(body.at(-1), "…");
  assert.equal(body.slice(0, -1), "x".repeat(199));
});
