import { describe, expect, it } from "vitest";

import {
  artifactContentHeaders,
  artifactContentSize,
  contentDisposition,
  isArtifactKind,
  isUuid,
} from "./artifact-api";

describe("artifact API validation", () => {
  it("accepts UUIDs and known artifact kinds only", () => {
    expect(isUuid("7f0e1ba4-2f7f-4a22-8ed4-14ff6b5d4d55")).toBe(true);
    expect(isUuid("../../artifact")).toBe(false);
    expect(isArtifactKind("presentation")).toBe(true);
    expect(isArtifactKind("executable")).toBe(false);
  });

  it("builds a safe RFC 5987 content disposition", () => {
    const value = contentDisposition('résumé "final".pdf', false);
    expect(value).toContain("inline;");
    expect(value).toContain('filename="r_sum_ _final_.pdf"');
    expect(value).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf");
    expect(value).not.toContain("\n");
  });

  it("uses persisted bytes when a streamed private Blob reports an unknown zero size", () => {
    expect(artifactContentSize(0, 32_576)).toBe(32_576);
    expect(artifactContentSize(null, 32_576)).toBe(32_576);
    expect(artifactContentSize(42, 32_576)).toBe(42);
  });

  it("forces active documents to download with a restrictive CSP", () => {
    for (const contentType of [
      "text/html; charset=utf-8",
      "application/xhtml+xml",
      "image/svg+xml",
    ]) {
      const headers = artifactContentHeaders({
        contentType,
        filename: "untrusted.html",
        size: 42,
        download: false,
      });
      expect(headers["Content-Disposition"]).toMatch(/^attachment;/);
      expect(headers["Content-Security-Policy"]).toContain("sandbox");
      expect(headers["Content-Security-Policy"]).toContain("default-src 'none'");
    }
  });

  it("keeps passive preview formats inline unless download is requested", () => {
    const inline = artifactContentHeaders({
      contentType: "application/pdf",
      filename: "report.pdf",
      size: 42,
      download: false,
    });
    const download = artifactContentHeaders({
      contentType: "application/pdf",
      filename: "report.pdf",
      size: 42,
      download: true,
    });
    expect(inline["Content-Disposition"]).toMatch(/^inline;/);
    expect(download["Content-Disposition"]).toMatch(/^attachment;/);
    expect(inline["Content-Security-Policy"]).toBeUndefined();
  });

  it("caches only explicitly versioned immutable content", () => {
    const current = artifactContentHeaders({
      contentType: "application/pdf",
      filename: "report.pdf",
      size: 42,
      download: false,
    });
    const version = artifactContentHeaders({
      contentType: "application/pdf",
      filename: "report.pdf",
      size: 42,
      download: false,
      immutable: true,
    });

    expect(current["Cache-Control"]).toBe("private, no-store");
    expect(version["Cache-Control"]).toBe(
      "private, max-age=31536000, immutable",
    );
  });
});
