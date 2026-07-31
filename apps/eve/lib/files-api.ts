export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;

export interface ChatFileView {
  id: string;
  threadId: string;
  threadTitle: string | null;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  contentUrl: string;
  downloadUrl: string;
}

export interface UploadedChatFile {
  id: string;
  threadId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  blobUrl: string;
  blobPath: string;
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function safeChatFilename(filename: string): string {
  const cleaned = filename
    .normalize("NFKC")
    .replaceAll(/[/\\\u0000-\u001f\u007f]/g, "-")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned.length > 0 ? cleaned : "attachment";
}

export function chatFilePath(id: string, filename: string): string {
  return `chat-files/${id}/${safeChatFilename(filename)}`;
}

export function contentDisposition(
  filename: string,
  download: boolean,
): string {
  const ascii = filename
    .replaceAll(/[^\u0020-\u007e]/g, "_")
    .replaceAll(/["\\]/g, "_")
    .slice(0, 180);
  const encoded = encodeURIComponent(filename).replaceAll("'", "%27");
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function chatFileContentSize(
  storageSize: number | null | undefined,
  persistedSize: number,
): number {
  // Private Blob represents a streamed response with no Content-Length as 0.
  // Forwarding that value would cause the outer response to discard the body.
  return storageSize === undefined || storageSize === null || storageSize <= 0
    ? persistedSize
    : storageSize;
}

const ACTIVE_DOCUMENT_TYPES = new Set([
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/html",
  "text/xml",
]);

export function chatFileContentHeaders(input: {
  contentType: string;
  filename: string;
  size: number;
  download: boolean;
}): Record<string, string> {
  const mimeType = input.contentType.split(";", 1)[0]?.trim().toLowerCase();
  const activeDocument =
    mimeType !== undefined && ACTIVE_DOCUMENT_TYPES.has(mimeType);
  return {
    "Content-Type": input.contentType,
    "Content-Length": String(input.size),
    "Content-Disposition": contentDisposition(
      input.filename,
      input.download || activeDocument,
    ),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...(activeDocument
      ? {
          "Content-Security-Policy":
            "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        }
      : {}),
  };
}
