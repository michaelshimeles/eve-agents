import {
  openArtifactContent,
  resolveArtifactShare,
} from "@/agent/lib/effect/artifacts";
import { runApp } from "@/agent/lib/effect/runtime";
import { apiFailure, artifactContentHeaders } from "@/lib/artifact-api";

type Context = { params: Promise<{ token: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { token } = await context.params;
  try {
    const shared = await runApp(resolveArtifactShare(token));
    const { blob } = await runApp(
      openArtifactContent(shared.artifact.id, shared.version.id),
    );
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(blob.stream, {
      headers: artifactContentHeaders({
        contentType: blob.blob.contentType ?? "application/octet-stream",
        filename: shared.version.filename,
        size: blob.blob.size ?? shared.version.sizeBytes,
        download,
      }),
    });
  } catch (error) {
    return apiFailure(error);
  }
}
