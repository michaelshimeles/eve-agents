import { describe, expect, it } from "vitest";

import {
  imessageContinuationToken,
  isIMessageResetCommand,
  legacyIMessageContinuationTokens,
  renderIMessageInputRequests,
  renderUndeliveredIMessageInputRequests,
} from "./imessage-session";

describe("imessageContinuationToken", () => {
  it("is stable inside one pairing and rotates with its secret", () => {
    const pairing = { handle: "+15551234567", secret: "pairing-secret-one" };
    expect(imessageContinuationToken(pairing, "+15550001111", null)).toBe(
      imessageContinuationToken(pairing, "+15550001111", null),
    );
    expect(imessageContinuationToken(pairing, "+15550001111", null)).not.toBe(
      imessageContinuationToken(
        { ...pairing, secret: "pairing-secret-two" },
        "+15550001111",
        null,
      ),
    );
  });

  it("keeps DMs and group spaces isolated", () => {
    const pairing = { handle: "+15551234567", secret: "pairing-secret" };
    expect(imessageContinuationToken(pairing, "+15550001111", null)).not.toBe(
      imessageContinuationToken(pairing, "+15550001111", "group-1"),
    );
    expect(imessageContinuationToken(pairing, "+15550001111", "group-1")).not.toBe(
      imessageContinuationToken(pairing, "+15550001111", "group-2"),
    );
  });

  it("keeps the same conversation on different Photon lines isolated", () => {
    const pairing = { handle: "+15551234567", secret: "pairing-secret" };
    expect(imessageContinuationToken(pairing, "+15550001111", null)).not.toBe(
      imessageContinuationToken(pairing, "+15550002222", null),
    );
  });

  it("retains the old token shape for one-time cleanup", () => {
    const pairing = { handle: "+15551234567", secret: "pairing-secret" };
    expect(legacyIMessageContinuationTokens(pairing, null)).toContain("+15551234567");
    expect(legacyIMessageContinuationTokens(pairing, "group-1")).toContain("group:group-1");
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

  it("does not duplicate requests already sent as native interactions", () => {
    const text = renderUndeliveredIMessageInputRequests(
      [
        { prompt: "First native prompt", display: "text" },
        { prompt: "Second fallback prompt", display: "text" },
      ],
      1,
    );

    expect(text).not.toContain("First native prompt");
    expect(text).toContain("Second fallback prompt");
    expect(renderUndeliveredIMessageInputRequests([{ prompt: "Done" }], 1)).toBeNull();
  });
});
