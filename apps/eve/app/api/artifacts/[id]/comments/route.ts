import { addArtifactComment, getArtifactDetail } from "@/agent/lib/effect/artifacts";
import { runApp } from "@/agent/lib/effect/runtime";
import { apiFailure } from "@/lib/artifact-api";
import { requireWebAuth } from "@/lib/web-auth";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    const detail = await runApp(getArtifactDetail(id));
    return Response.json({ comments: detail.comments });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    versionId?: unknown;
    body?: unknown;
    selection?: unknown;
  } | null;
  if (typeof body?.versionId !== "string" || typeof body.body !== "string") {
    return Response.json({ error: "Invalid comment." }, { status: 400 });
  }
  try {
    const comment = await runApp(
      addArtifactComment({
        artifactId: id,
        versionId: body.versionId,
        body: body.body,
        ...(body.selection === undefined ? {} : { selection: body.selection }),
        createdBy: "owner",
      }),
    );
    return Response.json({ comment }, { status: 201 });
  } catch (error) {
    return apiFailure(error);
  }
}
