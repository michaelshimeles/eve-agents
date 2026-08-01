import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  iMessageBackgroundInput,
  iMessageBackgroundRuntimeInput,
} from "../tools/imessage";

describe("iMessage dynamic tool schemas", () => {
  it("keeps the chat background input object-shaped through Eve's durable round trip", () => {
    const persisted = iMessageBackgroundInput.toJSONSchema({ target: "draft-7" });
    const rehydrated = z.fromJSONSchema(persisted, { defaultTarget: "draft-7" });
    const gatewaySchema = rehydrated.toJSONSchema({ target: "draft-7" });

    expect(gatewaySchema).toMatchObject({
      type: "object",
      properties: {
        background: {
          anyOf: [
            { type: "string", const: "clear" },
            { type: "string", pattern: "^[hH][tT][tT][pP][sS]:\\/\\/" },
          ],
        },
      },
      required: ["background"],
      additionalProperties: false,
    });
    expect(gatewaySchema).not.toHaveProperty("allOf");
  });

  it("requires exactly one chat background operation", () => {
    expect(
      iMessageBackgroundRuntimeInput.safeParse({
        background: "https://example.com/background.jpg",
      }).success,
    ).toBe(true);
    expect(
      iMessageBackgroundRuntimeInput.safeParse({
        background: "HTTPS://example.com/background.jpg",
      }).success,
    ).toBe(true);
    expect(iMessageBackgroundRuntimeInput.safeParse({ background: "clear" }).success).toBe(true);
    expect(iMessageBackgroundRuntimeInput.safeParse({}).success).toBe(false);
    expect(
      iMessageBackgroundRuntimeInput.safeParse({
        background: "http://example.com/background.jpg",
      }).success,
    ).toBe(false);
    expect(
      iMessageBackgroundRuntimeInput.safeParse({
        background: "https://example.com/background.jpg",
        clear: true,
      }).success,
    ).toBe(false);
  });
});
