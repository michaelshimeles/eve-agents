import { restoreArtifactVersion } from "@/agent/lib/effect/artifacts";
import { runApp } from "@/agent/lib/effect/runtime";
import { apiFailure } from "@/lib/artifact-api";
import { requireWebAuth } from "@/lib/web-auth";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { versionId?: unknown } | null;
  if (typeof body?.versionId !== "string") {
    return Response.json({ error: "Invalid revision." }, { status: 400 });
  }
  try {
    return Response.json({
      artifact: await runApp(restoreArtifactVersion(id, body.versionId, "owner")),
    });
  } catch (error) {
    return apiFailure(error);
  }
}
