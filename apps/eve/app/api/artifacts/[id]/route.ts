import {
  deleteArtifact,
  getArtifactDetail,
  renameArtifact,
} from "@/agent/lib/effect/artifacts";
import { runApp } from "@/agent/lib/effect/runtime";
import { apiFailure } from "@/lib/artifact-api";
import { requireWebAuth } from "@/lib/web-auth";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    return Response.json(await runApp(getArtifactDetail(id)));
  } catch (error) {
    return apiFailure(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
  if (typeof body?.title !== "string") {
    return Response.json({ error: "Invalid title." }, { status: 400 });
  }
  try {
    return Response.json({ artifact: await runApp(renameArtifact(id, body.title)) });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    const result = await runApp(deleteArtifact(id));
    return result.deleted
      ? Response.json({ ok: true })
      : Response.json({ error: "Artifact not found." }, { status: 404 });
  } catch (error) {
    return apiFailure(error);
  }
}
