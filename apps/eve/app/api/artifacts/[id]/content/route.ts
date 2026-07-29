import { openArtifactContent } from "@/agent/lib/effect/artifacts";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  apiFailure,
  artifactContentHeaders,
  artifactContentSize,
} from "@/lib/artifact-api";
import { requireWebAuth } from "@/lib/web-auth";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  const url = new URL(request.url);
  const versionId = url.searchParams.get("versionId") ?? undefined;
  try {
    const { version, blob } = await runApp(openArtifactContent(id, versionId));
    const download = url.searchParams.get("download") === "1";
    return new Response(blob.stream, {
      headers: artifactContentHeaders({
        contentType: blob.blob.contentType ?? "application/octet-stream",
        filename: version.filename,
        size: artifactContentSize(blob.blob.size, version.sizeBytes),
        download,
      }),
    });
  } catch (error) {
    return apiFailure(error);
  }
}
