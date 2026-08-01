import {
  createArtifactShare,
  listArtifactShares,
} from "@/agent/lib/effect/artifacts";
import { runApp } from "@/agent/lib/effect/runtime";
import { apiFailure } from "@/lib/artifact-api";
import { requireWebAuth } from "@/lib/web-auth";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    return Response.json({ shares: await runApp(listArtifactShares(id)) });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    versionId?: unknown;
    expiresInDays?: unknown;
  } | null;
  if (
    typeof body?.versionId !== "string" ||
    (body.expiresInDays !== undefined && typeof body.expiresInDays !== "number")
  ) {
    return Response.json({ error: "Invalid share." }, { status: 400 });
  }
  try {
    const result = await runApp(
      createArtifactShare({
        artifactId: id,
        versionId: body.versionId,
        expiresInDays: body.expiresInDays ?? 7,
      }),
    );
    const origin = new URL(request.url).origin;
    return Response.json(
      {
        share: result.share,
        url: `${origin}/share/${encodeURIComponent(result.token)}`,
      },
      { status: 201 },
    );
  } catch (error) {
    return apiFailure(error);
  }
}
