import { describe, expect, it } from "vitest";

import {
  chatFileContentSize,
  chatFileContentHeaders,
  chatFilePath,
  contentDisposition,
  safeChatFilename,
} from "./files-api";

describe("chat file API helpers", () => {
  it("keeps upload paths inside one file id", () => {
    expect(chatFilePath("file-id", "../ Screenshot.png")).toBe(
      "chat-files/file-id/..- Screenshot.png",
    );
    expect(safeChatFilename("  folder\\name\u0000.png  ")).toBe(
      "folder-name-.png",
    );
  });

  it("emits a UTF-8-safe content disposition", () => {
    expect(contentDisposition("café.png", true)).toContain(
      "filename*=UTF-8''caf%C3%A9.png",
    );
  });

  it("uses the persisted size when private Blob omits its stream length", () => {
    expect(chatFileContentSize(0, 42)).toBe(42);
    expect(chatFileContentSize(undefined, 42)).toBe(42);
    expect(chatFileContentSize(39, 42)).toBe(39);
  });

  it("forces active documents to download under a restrictive sandbox", () => {
    const headers = chatFileContentHeaders({
      contentType: "image/svg+xml",
      filename: "drawing.svg",
      size: 42,
      download: false,
    });
    expect(headers["Content-Disposition"]).toMatch(/^attachment/);
    expect(headers["Content-Security-Policy"]).toContain("sandbox");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("allows passive images to render inline", () => {
    const headers = chatFileContentHeaders({
      contentType: "image/png",
      filename: "photo.png",
      size: 42,
      download: false,
    });
    expect(headers["Content-Disposition"]).toMatch(/^inline/);
    expect(headers["Content-Security-Policy"]).toBeUndefined();
  });
});
