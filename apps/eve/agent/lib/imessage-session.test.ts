import { describe, expect, it } from "vitest";

import {
  imessageContinuationToken,
  isIMessageResetCommand,
  legacyIMessageContinuationToken,
  renderIMessageInputRequests,
} from "./imessage-session";

describe("imessageContinuationToken", () => {
  it("is stable inside one pairing and rotates with its secret", () => {
    const pairing = { handle: "+15551234567", secret: "pairing-secret-one" };
    expect(imessageContinuationToken(pairing, null)).toBe(
      imessageContinuationToken(pairing, null),
    );
    expect(imessageContinuationToken(pairing, null)).not.toBe(
      imessageContinuationToken(
        { ...pairing, secret: "pairing-secret-two" },
        null,
      ),
    );
  });

  it("keeps DMs and group spaces isolated", () => {
    const pairing = { handle: "+15551234567", secret: "pairing-secret" };
    expect(imessageContinuationToken(pairing, null)).not.toBe(
      imessageContinuationToken(pairing, "group-1"),
    );
    expect(imessageContinuationToken(pairing, "group-1")).not.toBe(
      imessageContinuationToken(pairing, "group-2"),
    );
  });

  it("retains the old token shape for one-time cleanup", () => {
    expect(legacyIMessageContinuationToken("+15551234567", null)).toBe(
      "+15551234567",
    );
    expect(legacyIMessageContinuationToken("+15551234567", "group-1")).toBe(
      "group:group-1",
    );
  });
});

describe("isIMessageResetCommand", () => {
  it("accepts only a standalone, text-only /new command", () => {
    expect(isIMessageResetCommand(" /NEW ", false)).toBe(true);
    expect(isIMessageResetCommand("/new please", false)).toBe(false);
    expect(isIMessageResetCommand("/new", true)).toBe(false);
    expect(isIMessageResetCommand(null, false)).toBe(false);
  });
});

describe("renderIMessageInputRequests", () => {
  it("makes approval answers and recovery explicit", () => {
    const text = renderIMessageInputRequests([
      {
        display: "confirmation",
        prompt: "Approve tool call: buy",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      },
    ]);

    expect(text).toContain("Approve tool call: buy");
    expect(text).toContain("Reply APPROVE to continue or DENY to cancel.");
    expect(text).toContain("Reply /new anytime");
  });

  it("lists selectable answers for non-approval questions", () => {
    expect(
      renderIMessageInputRequests([
        {
          prompt: "Which one?",
          display: "select",
          options: [
            { id: "one", label: "First" },
            { id: "two", label: "Second" },
          ],
        },
      ]),
    ).toContain("1. First\n2. Second");
  });
});
