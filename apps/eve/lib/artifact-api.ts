import type { ArtifactKind } from "@/agent/lib/effect/artifacts";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return (
    value === "markdown" ||
    value === "html" ||
    value === "pdf" ||
    value === "spreadsheet" ||
    value === "presentation" ||
    value === "file"
  );
}

export function apiFailure(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Artifact request failed.";
  const status = message.includes("not found") || message.includes("invalid, expired")
    ? 404
    : message.includes("need DATABASE_URL") || message.includes("private Vercel Blob")
      ? 503
      : message.includes("must be") ||
          message.includes("does not match") ||
          message.includes("limited to") ||
          message.includes("Only Markdown")
        ? 400
        : 500;
  return Response.json({ error: message }, { status });
}

export function bytesFromText(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

export function artifactContentSize(
  storageSize: number | null | undefined,
  persistedSize: number,
): number {
  // Private Blob downloads may be streamed without a Content-Length header.
  // @vercel/blob represents that unknown length as 0, which would make the
  // outer response discard a non-empty stream if forwarded verbatim.
  return storageSize === undefined || storageSize === null || storageSize <= 0
    ? persistedSize
    : storageSize;
}

export function contentDisposition(filename: string, download: boolean): string {
  const ascii = filename
    .replaceAll(/[^\u0020-\u007e]/g, "_")
    .replaceAll(/["\\]/g, "_")
    .slice(0, 180);
  const encoded = encodeURIComponent(filename).replaceAll("'", "%27");
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const ACTIVE_DOCUMENT_TYPES = new Set([
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/html",
  "text/xml",
]);

export function artifactContentHeaders(input: {
  readonly contentType: string;
  readonly filename: string;
  readonly size: number;
  readonly download: boolean;
  readonly immutable?: boolean;
}): Record<string, string> {
  const mimeType = input.contentType.split(";", 1)[0]?.trim().toLowerCase();
  const activeDocument = mimeType !== undefined && ACTIVE_DOCUMENT_TYPES.has(mimeType);
  return {
    "Content-Type": input.contentType,
    "Content-Length": String(input.size),
    "Content-Disposition": contentDisposition(
      input.filename,
      input.download || activeDocument,
    ),
    // A versionId names one immutable Blob revision, so the browser can keep
    // it indefinitely and switching between artifacts does not download the
    // same document again. Unversioned "current revision" URLs remain
    // uncached because a later artifact_update changes what they mean.
    "Cache-Control": input.immutable
      ? "private, max-age=31536000, immutable"
      : "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...(activeDocument
      ? {
          // Direct navigation must never turn user-controlled HTML, XHTML,
          // XML, or SVG into a privileged same-origin application document.
          // The workspace fetches HTML as text and renders it in a sandboxed
          // srcDoc iframe, so these response-level restrictions do not affect
          // the intended preview.
          "Content-Security-Policy":
            "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        }
      : {}),
  };
}
