import { describe, expect, it } from "vitest";

import {
  iMessageBackgroundInput,
  iMessageBackgroundRuntimeInput,
} from "../tools/imessage";

describe("iMessage dynamic tool schemas", () => {
  it("projects the chat background input as a top-level exclusive object", () => {
    expect(iMessageBackgroundInput).toMatchObject({
      type: "object",
      properties: {
        url: { type: "string" },
        clear: { type: "boolean", const: true },
      },
      additionalProperties: false,
      oneOf: [{ required: ["url"] }, { required: ["clear"] }],
    });
  });

  it("requires exactly one chat background operation", () => {
    expect(
      iMessageBackgroundRuntimeInput.safeParse({
        url: "https://example.com/background.jpg",
      }).success,
    ).toBe(true);
    expect(iMessageBackgroundRuntimeInput.safeParse({ clear: true }).success).toBe(true);
    expect(iMessageBackgroundRuntimeInput.safeParse({}).success).toBe(false);
    expect(
      iMessageBackgroundRuntimeInput.safeParse({
        url: "https://example.com/background.jpg",
        clear: true,
      }).success,
    ).toBe(false);
  });
});
