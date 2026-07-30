// Staging and preparation for files handed to the voice orb. Every image ends
// up in two forms: a small JPEG "glance copy" the voice model can look at over
// the data channel, and the untouched original that goes to the real agent.
import type { UserContent } from "ai";

/** Matches the chat composer's per-file cap. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_STAGED_FILES = 5;
/** RFC 8841 default when the SDP answer omits a=max-message-size. */
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;
export const GLANCE_MAX_EDGE = 768;

export interface VoiceAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  dataUrl: string;
}

export type RejectionReason = "too_large" | "too_many" | "unreadable";

export interface StageResult {
  accepted: VoiceAttachment[];
  rejected: { name: string; reason: RejectionReason }[];
}

/** Chunked so a large file cannot blow the argument limit of fromCharCode. */
const BASE64_CHUNK = 0x8000;

/**
 * Blob.arrayBuffer + btoa rather than FileReader: same result, no event
 * plumbing, and it works anywhere modern — including under the test runner,
 * where FileReader does not exist.
 */
async function readFileAsDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

export function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

export async function stageAttachments(
  files: Iterable<File>,
  existingCount: number,
): Promise<StageResult> {
  // Snapshot before the first await. An <input type="file"> hands over its
  // *live* FileList, and every picker handler clears `input.value` right after
  // calling us so the same file can be picked twice — which empties that same
  // list in place. Iterating it lazily would read one file, suspend on the
  // FileReader, and find an empty list on resume: every file after the first
  // would vanish without even being reported as rejected.
  const pending = [...files];
  const accepted: VoiceAttachment[] = [];
  const rejected: StageResult["rejected"] = [];
  let count = existingCount;
  for (const file of pending) {
    const name = file.name || "pasted-file";
    if (count >= MAX_STAGED_FILES) {
      rejected.push({ name, reason: "too_many" });
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ name, reason: "too_large" });
      continue;
    }
    try {
      accepted.push({
        id: crypto.randomUUID(),
        name,
        mediaType: file.type || "application/octet-stream",
        size: file.size,
        dataUrl: await readFileAsDataUrl(file),
      });
      count += 1;
    } catch {
      rejected.push({ name, reason: "unreadable" });
    }
  }
  return { accepted, rejected };
}

/** The exact part shape the chat composer sends (see app/chat.tsx). */
export function toUserContent(text: string, attachments: readonly VoiceAttachment[]): UserContent {
  return [
    ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
    ...attachments.map((attachment) => ({
      type: "file" as const,
      data: attachment.dataUrl,
      mediaType: attachment.mediaType,
      filename: attachment.name,
    })),
  ];
}

/**
 * The peer advertises its ceiling in the SDP answer. Absent or unusable values
 * fall back to the spec default rather than optimistically assuming more.
 */
export function parseMaxMessageBytes(sdp: string): number {
  const match = /a=max-message-size:\s*(\d+)/i.exec(sdp);
  if (match === null) return DEFAULT_MAX_MESSAGE_BYTES;
  const value = Number.parseInt(match[1], 10);
  // 0 means "no limit" per RFC 8841, but we still want a sane working budget.
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_MESSAGE_BYTES;
  return value;
}

/**
 * Largest glance we will ever send, regardless of what the peer allows. OpenAI
 * advertises a very large max-message-size, and an unclamped budget would let a
 * multi-megabyte JPEG through — billed as image tokens and re-sent with every
 * subsequent turn. A 768px JPEG lands far below this.
 */
export const MAX_GLANCE_BYTES = 180 * 1024;

/**
 * How many raw image bytes fit in one data-channel message: base64 inflates by
 * 4/3, and the JSON envelope plus the data: prefix cost a little more. The 0.7
 * factor keeps a margin so a borderline image never wedges the channel, and the
 * clamp keeps cost bounded when the peer is generous.
 */
export function glanceBudget(maxMessageBytes: number): number {
  const fromChannel = Math.floor((((maxMessageBytes - 2_048) * 3) / 4 / 1.05) * 0.7);
  return Math.max(0, Math.min(fromChannel, MAX_GLANCE_BYTES));
}

const GLANCEABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);

/** Formats a browser canvas can reliably decode and re-encode as JPEG. */
export function isGlanceable(mediaType: string): boolean {
  return GLANCEABLE.has(mediaType.toLowerCase());
}

export function describeAttachments(attachments: readonly VoiceAttachment[]): string {
  return attachments
    .map((attachment) => `${attachment.name} (${formatBytes(attachment.size)})`)
    .join(", ");
}

export function rejectionNote(
  rejected: readonly { name: string; reason: RejectionReason }[],
): string | null {
  if (rejected.length === 0) return null;
  const reasons: Record<RejectionReason, string> = {
    too_large: "too large",
    too_many: "over the limit of five files at once",
    unreadable: "unreadable",
  };
  return rejected.map((item) => `${item.name} was ${reasons[item.reason]}`).join("; ");
}

/**
 * Re-encode an image small enough to cross the data channel. Steps quality
 * down, then dimensions, and gives up rather than sending something oversized.
 * Returns null when the image cannot be decoded (HEIC in most browsers) or
 * cannot be squeezed into the budget.
 */
export async function downscaleToFit(
  dataUrl: string,
  budgetBytes: number,
  maxEdge: number = GLANCE_MAX_EDGE,
): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    for (const edge of [maxEdge, 512, 384]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) return null;
      // JPEG has no alpha channel: without this, every transparent pixel of a
      // PNG screenshot composites to black and the model sees a mostly-black
      // image. White matches the usual light-background screenshot.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.7, 0.55, 0.4]) {
        const encoded = canvas.toDataURL("image/jpeg", quality);
        const bytes = Math.ceil(((encoded.length - encoded.indexOf(",") - 1) * 3) / 4);
        if (bytes <= budgetBytes) return encoded;
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}
