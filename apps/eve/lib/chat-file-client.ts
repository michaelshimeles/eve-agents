"use client";

import { upload } from "@vercel/blob/client";

import {
  chatFilePath,
  type ChatFileView,
  type UploadedChatFile,
} from "@/lib/files-api";

export interface ChatUploadSource {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  file: File;
}

export type ChatUploadBatch<T> =
  | {
      readonly complete: true;
      readonly files: readonly T[];
    }
  | {
      readonly complete: false;
      readonly failedCount: number;
      readonly files: readonly (T | undefined)[];
    };

/**
 * Makes the send boundary explicit: callers only receive an all-durable file
 * list from the complete branch. The partial branch retains successful
 * uploads for retry but must never be sent to the model or transcript.
 */
export function inspectChatUploads<T>(
  results: readonly PromiseSettledResult<T>[],
): ChatUploadBatch<T> {
  const files = results.map((result) =>
    result.status === "fulfilled" ? result.value : undefined,
  );
  const failedCount = results.filter(
    (result) => result.status === "rejected",
  ).length;
  return failedCount === 0
    ? { complete: true, files: files as T[] }
    : { complete: false, failedCount, files };
}

async function confirmUpload(
  uploaded: UploadedChatFile,
): Promise<ChatFileView> {
  let lastError = "The file was uploaded but could not be added to Files.";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch("/api/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(uploaded),
      });
      const body = (await response.json().catch(() => null)) as {
        file?: ChatFileView;
        error?: string;
      } | null;
      if (response.ok && body?.file !== undefined) return body.file;
      lastError = body?.error ?? lastError;
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      )
        break;
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  throw new Error(lastError);
}

export async function persistChatUpload(
  threadId: string,
  attachment: ChatUploadSource,
): Promise<ChatFileView> {
  const payload = {
    id: attachment.id,
    threadId,
    filename: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.size,
  };
  const blob = await upload(
    chatFilePath(attachment.id, attachment.name),
    attachment.file,
    {
      access: "private",
      contentType: attachment.mediaType,
      handleUploadUrl: "/api/files/upload",
      clientPayload: JSON.stringify(payload),
      multipart: attachment.size > 5 * 1024 * 1024,
    },
  );
  const uploaded: UploadedChatFile = {
    ...payload,
    blobUrl: blob.url,
    blobPath: blob.pathname,
  };
  // The Blob completion callback registers the record too. This explicit,
  // idempotent confirmation makes the file visible before the Files view is
  // opened, covers callback delays, and retries transient metadata failures.
  return confirmUpload(uploaded);
}
