import { describe, expect, it } from "vitest";

import { iMessageMarkdownSnapshots } from "./imessage-stream";

describe("iMessageMarkdownSnapshots", () => {
  it("keeps an ordinary single-block reply as one send", () => {
    expect(iMessageMarkdownSnapshots("  One concise answer.  ")).toEqual([
      "One concise answer.",
    ]);
  });

  it("reveals complete markdown blocks and finishes with the exact answer", () => {
    const text = "# Result\n\nFirst paragraph.\n\n- one\n- two";
    expect(iMessageMarkdownSnapshots(text)).toEqual([
      "# Result",
      "# Result\n\nFirst paragraph.",
      text,
    ]);
  });

  it("coalesces long answers to a bounded number of native edits", () => {
    const text = Array.from({ length: 40 }, (_, index) => `Block ${index + 1}`).join(
      "\n\n",
    );
    const snapshots = iMessageMarkdownSnapshots(text);
    expect(snapshots.length).toBeLessThanOrEqual(8);
    expect(snapshots.at(-1)).toBe(text);
  });
});
