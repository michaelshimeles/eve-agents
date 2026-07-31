import { listChatFiles, registerChatFile } from "@/agent/lib/effect/chat-files";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  isUuid,
  type ChatFileView,
  type UploadedChatFile,
} from "@/lib/files-api";
import { requireWebAuth, webRequestPrincipal } from "@/lib/web-auth";

function fileView(file: {
  id: string;
  threadId: string;
  threadTitle: string | null;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
}): ChatFileView {
  const base = `/api/files/${encodeURIComponent(file.id)}/content`;
  return {
    ...file,
    contentUrl: base,
    downloadUrl: `${base}?download=1`,
  };
}

function apiFailure(error: unknown): Response {
  const message =
    error instanceof Error ? error.message : "File request failed.";
  const status = message.includes("not found")
    ? 404
    : message.includes("need DATABASE_URL") ||
        message.includes("private Vercel Blob")
      ? 503
      : message.includes("invalid") || message.includes("does not match")
        ? 400
        : 500;
  return Response.json({ error: message }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const principal = webRequestPrincipal();
  try {
    const files = await runApp(listChatFiles(principal.principalId));
    return Response.json({ files: files.map(fileView) });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const principal = webRequestPrincipal();
  const body = (await request
    .json()
    .catch(() => null)) as Partial<UploadedChatFile> | null;
  if (
    body === null ||
    !isUuid(body.id) ||
    !isUuid(body.threadId) ||
    typeof body.filename !== "string" ||
    typeof body.mediaType !== "string" ||
    typeof body.sizeBytes !== "number" ||
    typeof body.blobUrl !== "string" ||
    typeof body.blobPath !== "string"
  ) {
    return Response.json({ error: "Invalid file metadata." }, { status: 400 });
  }
  try {
    const file = await runApp(
      registerChatFile(principal.principalId, {
        id: body.id,
        threadId: body.threadId,
        filename: body.filename,
        mediaType: body.mediaType,
        sizeBytes: body.sizeBytes,
        blobUrl: body.blobUrl,
        blobPath: body.blobPath,
      }),
    );
    return Response.json({ file: fileView(file) });
  } catch (error) {
    return apiFailure(error);
  }
}
