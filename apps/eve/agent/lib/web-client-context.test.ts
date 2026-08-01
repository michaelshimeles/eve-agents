import { describe, expect, it } from "vitest";

import { webThreadId } from "./web-client-context";

describe("webThreadId", () => {
  it("reads the newest valid client context marker", () => {
    expect(
      webThreadId([
        { role: "user", content: "Client context:\n{\"eveWebThreadId\":\"older\"}" },
        { role: "assistant", content: "Working on it." },
        { role: "user", content: "Client context:\n{\"eveWebThreadId\":\"newer\"}" },
      ]),
    ).toBe("newer");
  });

  it("does not accept ordinary conversation text as client context", () => {
    expect(
      webThreadId([
        {
          role: "user",
          content: "The phrase eveWebThreadId appears here, but this is not a marker.",
        },
      ]),
    ).toBeNull();
  });
});
