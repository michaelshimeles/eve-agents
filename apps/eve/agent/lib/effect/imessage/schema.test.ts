import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  IMessageCommand,
  commandConversationKey,
  commandIdFor,
  requiresOwner,
  sensitiveCommandPayloadHash,
} from "./schema";

describe("iMessage command schema", () => {
  const base = {
    version: 2 as const,
    commandId: "request:block:0",
    phone: "+14165550100",
    actor: { role: "owner" as const, deploymentId: "deployment-1" },
    target: { kind: "dm" as const, handle: "+14165550101" },
    operation: "send_text" as const,
    payload: { text: "hello" },
  };

  it("decodes a v2 command and pins its conversation to the line", () => {
    const command = Schema.decodeUnknownSync(IMessageCommand)(base);
    expect(commandConversationKey(command)).toBe(
      "dm:+14165550100:+14165550101",
    );
  });

  it("rejects unknown operations and old versions", () => {
    expect(() =>
      Schema.decodeUnknownSync(IMessageCommand)({
        ...base,
        version: 1,
        operation: "raw_provider_payload",
      }),
    ).toThrow();
  });

  it("requires owner authority for consequential operations", () => {
    expect(requiresOwner({ ...base, operation: "remove_participant" })).toBe(true);
    expect(requiresOwner(base)).toBe(false);
  });

  it("derives stable business ids from the Eve output position", () => {
    expect(commandIdFor("request", "block", 3)).toBe("request:block:3");
    expect(commandIdFor("request", "block", 3)).toBe(
      commandIdFor("request", "block", 3),
    );
  });

  it("binds sensitive approvals to operation and canonical payload", () => {
    const left = sensitiveCommandPayloadHash("request_location", {
      address: "+14165550101",
      durationSeconds: 300,
      approval: { interactionId: "ignored" },
    });
    const reordered = sensitiveCommandPayloadHash("request_location", {
      durationSeconds: 300,
      address: "+14165550101",
    });
    expect(left).toBe(reordered);
    expect(left).not.toBe(
      sensitiveCommandPayloadHash("request_location", {
        address: "+14165550101",
        durationSeconds: 301,
      }),
    );
    expect(left).not.toBe(
      sensitiveCommandPayloadHash("notify_anyway", {
        address: "+14165550101",
        durationSeconds: 300,
      }),
    );
  });
});
