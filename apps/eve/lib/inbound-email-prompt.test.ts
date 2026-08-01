import { describe, expect, it } from "vitest";

import { compactEmailPreview, parseInboundEmailPrompt } from "./inbound-email-prompt";

const PROMPT = [
  "New email in your own inbox (ruth@example.com). This arrived on its own - Micky didn't just message you.",
  "",
  "From: Uber Eats <news@uber.com>",
  "To: ruth@example.com",
  "Subject: Explore restaurants near you",
  "Received: 2026-07-30T14:23:00.000Z",
  "Thread id: thread_123",
  "Message id: message_456",
  "",
  "Body:",
  "```",
  "",
  "",
  "Help Center",
  "",
  "",
  "Terms",
  "",
  "This is a promotional email from Uber Technologies.",
  "```",
  "",
  "Triage it: say who wrote and what they want, then what you suggest doing.",
].join("\n");

describe("parseInboundEmailPrompt", () => {
  it("extracts the email without exposing the internal triage instructions", () => {
    expect(parseInboundEmailPrompt(PROMPT)).toEqual({
      from: "Uber Eats <news@uber.com>",
      to: "ruth@example.com",
      subject: "Explore restaurants near you",
      received: "2026-07-30T14:23:00.000Z",
      threadId: "thread_123",
      messageId: "message_456",
      body: "Help Center\n\n\nTerms\n\nThis is a promotional email from Uber Technologies.",
    });
  });

  it("leaves ordinary user messages alone", () => {
    expect(parseInboundEmailPrompt("Can you check Ruth's email?")).toBeNull();
  });
});

describe("compactEmailPreview", () => {
  it("collapses newsletter whitespace and bounds the visible preview", () => {
    expect(compactEmailPreview("Help Center\n\n   Terms\n\nPrivacy")).toBe(
      "Help Center Terms Privacy",
    );
    expect(compactEmailPreview("a".repeat(400))).toBe(`${"a".repeat(320)}…`);
  });
});
