import { openChatFile } from "@/agent/lib/effect/chat-files";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  chatFileContentHeaders,
  chatFileContentSize,
  isUuid,
} from "@/lib/files-api";
import { webRequestPrincipal } from "@/lib/web-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const principal = webRequestPrincipal();
  const { id } = await context.params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });
  try {
    const { file, blob } = await runApp(
      openChatFile(principal.principalId, id),
    );
    return new Response(blob.stream, {
      headers: chatFileContentHeaders({
        contentType: blob.blob.contentType ?? file.mediaType,
        filename: file.filename,
        size: chatFileContentSize(blob.blob.size, file.sizeBytes),
        download: new URL(request.url).searchParams.get("download") === "1",
      }),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "File request failed.";
    return Response.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 500 },
    );
  }
}
