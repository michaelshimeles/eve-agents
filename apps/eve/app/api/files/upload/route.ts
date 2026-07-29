import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { registerChatFile } from "@/agent/lib/effect/chat-files";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  chatFilePath,
  isUuid,
  MAX_CHAT_FILE_BYTES,
  type UploadedChatFile,
} from "@/lib/files-api";
import {
  authenticateWebRequest,
  WEB_OWNER_PRINCIPAL_ID,
} from "@/lib/web-auth";

type UploadPayload = Omit<UploadedChatFile, "blobUrl" | "blobPath">;
type AuthorizedUploadPayload = UploadPayload & {
  ownerId: typeof WEB_OWNER_PRINCIPAL_ID;
};

function parsePayload(value: string | null): UploadPayload {
  const parsed = JSON.parse(value ?? "{}") as Partial<UploadPayload>;
  if (
    !isUuid(parsed.id) ||
    !isUuid(parsed.threadId) ||
    typeof parsed.filename !== "string" ||
    typeof parsed.mediaType !== "string" ||
    typeof parsed.sizeBytes !== "number" ||
    !Number.isSafeInteger(parsed.sizeBytes) ||
    parsed.sizeBytes < 0 ||
    parsed.sizeBytes > MAX_CHAT_FILE_BYTES
  ) {
    throw new Error("Invalid chat file upload identity.");
  }
  return parsed as UploadPayload;
}

function parseAuthorizedPayload(value: string | null): AuthorizedUploadPayload {
  const parsed = JSON.parse(value ?? "{}") as Partial<AuthorizedUploadPayload>;
  const payload = parsePayload(value);
  if (parsed.ownerId !== WEB_OWNER_PRINCIPAL_ID) {
    throw new Error("Invalid chat file owner.");
  }
  return { ...payload, ownerId: parsed.ownerId };
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request
    .json()
    .catch(() => null)) as HandleUploadBody | null;
  if (body === null) {
    return Response.json({ error: "Invalid upload request." }, { status: 400 });
  }
  // The browser must pass the app's auth gate to mint an upload token. The
  // authenticated owner is sealed into Blob's SDK-signed token payload so the
  // completion webhook can register the same owner without trusting client
  // metadata.
  let ownerId: typeof WEB_OWNER_PRINCIPAL_ID | null = null;
  if (body.type === "blob.generate-client-token") {
    const authentication = authenticateWebRequest(request);
    if (authentication instanceof Response) return authentication;
    ownerId = authentication.principalId;
  }
  try {
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = parsePayload(clientPayload);
        if (ownerId === null) {
          throw new Error("Authentication is required.");
        }
        if (pathname !== chatFilePath(payload.id, payload.filename)) {
          throw new Error("Invalid chat file upload path.");
        }
        return {
          maximumSizeInBytes: MAX_CHAT_FILE_BYTES,
          addRandomSuffix: false,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({ ...payload, ownerId }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = parseAuthorizedPayload(tokenPayload ?? null);
        await runApp(
          registerChatFile(payload.ownerId, {
            id: payload.id,
            threadId: payload.threadId,
            filename: payload.filename,
            mediaType: payload.mediaType,
            sizeBytes: payload.sizeBytes,
            blobUrl: blob.url,
            blobPath: blob.pathname,
          }),
        );
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not authorize upload.",
      },
      { status: 400 },
    );
  }
}
