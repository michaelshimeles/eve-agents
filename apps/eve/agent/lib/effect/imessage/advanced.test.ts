import { describe, expect, it } from "vitest";

import { parseNativeIMessageText } from "./advanced";

describe("Advanced iMessage native text", () => {
  it("converts supported markup into exact UTF-16 formatting ranges", () => {
    const parsed = parseNativeIMessageText(
      "**Bold** then *italic* and <u>under</u> plus ~~strike~~",
    );
    expect(parsed.text).toBe("Bold then italic and under plus strike");
    expect(parsed.formatting).toEqual([
      { type: "bold", start: 0, length: 4 },
      { type: "italic", start: 10, length: 6 },
      { type: "underline", start: 21, length: 5 },
      { type: "strikethrough", start: 32, length: 6 },
    ]);
  });

  it("preserves animated text effects with their native range", () => {
    expect(
      parseNativeIMessageText("A [effect=ripple]wave🌊[/effect] arrives"),
    ).toEqual({
      text: "A wave🌊 arrives",
      formatting: [
        {
          type: "effect",
          start: 2,
          // JavaScript string indices are UTF-16 code units, matching the SDK.
          length: 6,
          effect: "ripple",
        },
      ],
    });
  });
});
