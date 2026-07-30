import {
  deleteArtifactDraft,
  getArtifactDraft,
  saveArtifactDraft,
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
    return Response.json({ draft: await runApp(getArtifactDraft(id)) });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { content?: unknown } | null;
  if (typeof body?.content !== "string") {
    return Response.json({ error: "Invalid draft." }, { status: 400 });
  }
  try {
    return Response.json({ draft: await runApp(saveArtifactDraft(id, body.content)) });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    await runApp(deleteArtifactDraft(id));
    return Response.json({ ok: true });
  } catch (error) {
    return apiFailure(error);
  }
}
