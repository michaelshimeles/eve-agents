import { describe, expect, it } from "vitest";

import { inspectChatUploads } from "./chat-file-client";

describe("inspectChatUploads", () => {
  it("only exposes a sendable file list when every upload is durable", () => {
    expect(
      inspectChatUploads([
        { status: "fulfilled", value: "first" },
        { status: "fulfilled", value: "second" },
      ]),
    ).toEqual({
      complete: true,
      files: ["first", "second"],
    });
  });

  it("fails the batch while retaining successful uploads for retry", () => {
    expect(
      inspectChatUploads([
        { status: "fulfilled", value: "saved" },
        { status: "rejected", reason: new Error("Blob unavailable") },
      ]),
    ).toEqual({
      complete: false,
      failedCount: 1,
      files: ["saved", undefined],
    });
  });
});
