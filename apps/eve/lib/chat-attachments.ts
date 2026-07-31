import type { UserContent } from "ai";

import { downscaleToFit, isGlanceable } from "@/lib/voice/attachments";

/** Eve rehydrates image attachments into model input only below 3 MiB. */
export const MODEL_IMAGE_BUDGET_BYTES = 2_750_000;
export const MODEL_IMAGE_MAX_EDGE = 2048;

export interface PreparedChatAttachment {
  name: string;
  mediaType: string;
  size: number;
  dataUrl: string;
}

export type ImageScaler = (
  dataUrl: string,
  budgetBytes: number,
  maxEdge: number,
) => Promise<string | null>;

/**
 * Builds the AI SDK message while preserving file parts (the current AI SDK
 * image input shape). Large raster images get a visual copy under Eve's
 * rehydration ceiling; the original remains untouched for durable storage.
 */
export async function toModelUserContent(
  text: string,
  attachments: readonly PreparedChatAttachment[],
  scaleImage: ImageScaler = downscaleToFit,
): Promise<UserContent> {
  const parts: UserContent = text.length > 0 ? [{ type: "text", text }] : [];
  for (const attachment of attachments) {
    let data = attachment.dataUrl;
    let mediaType = attachment.mediaType;
    let filename = attachment.name;
    if (
      attachment.size > MODEL_IMAGE_BUDGET_BYTES &&
      isGlanceable(attachment.mediaType)
    ) {
      const scaled = await scaleImage(
        attachment.dataUrl,
        MODEL_IMAGE_BUDGET_BYTES,
        MODEL_IMAGE_MAX_EDGE,
      ).catch(() => null);
      if (scaled !== null) {
        data = scaled;
        mediaType = "image/jpeg";
        filename = `${attachment.name.replace(/\.[^.]+$/, "") || "image"}-for-ruth.jpg`;
      }
    }
    parts.push({ type: "file", data, mediaType, filename });
  }
  return parts;
}
