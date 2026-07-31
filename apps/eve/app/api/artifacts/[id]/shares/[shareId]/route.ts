import { revokeArtifactShare } from "@/agent/lib/effect/artifacts";
import { runApp } from "@/agent/lib/effect/runtime";
import { apiFailure } from "@/lib/artifact-api";
import { requireWebAuth } from "@/lib/web-auth";

type Context = { params: Promise<{ id: string; shareId: string }> };

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id, shareId } = await context.params;
  try {
    const result = await runApp(revokeArtifactShare(id, shareId));
    return result.revoked
      ? Response.json({ ok: true })
      : Response.json({ error: "Share not found." }, { status: 404 });
  } catch (error) {
    return apiFailure(error);
  }
}
