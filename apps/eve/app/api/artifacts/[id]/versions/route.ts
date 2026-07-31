import {
  createArtifactVersion,
  getArtifactDetail,
  registerUploadedArtifactVersion,
} from "@/agent/lib/effect/artifacts";
import { runApp } from "@/agent/lib/effect/runtime";
import { apiFailure, bytesFromText, isUuid } from "@/lib/artifact-api";
import { requireWebAuth } from "@/lib/web-auth";

type Context = { params: Promise<{ id: string }> };

interface VersionBody {
  versionId?: unknown;
  filename?: unknown;
  mimeType?: unknown;
  content?: unknown;
  changeSummary?: unknown;
  blob?: {
    url?: unknown;
    pathname?: unknown;
    size?: unknown;
    sha256?: unknown;
  };
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    const detail = await runApp(getArtifactDetail(id));
    return Response.json({ versions: detail.versions });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as VersionBody | null;
  if (
    body === null ||
    !isUuid(body.versionId) ||
    typeof body.filename !== "string" ||
    (body.mimeType !== undefined && typeof body.mimeType !== "string") ||
    (body.changeSummary !== undefined && typeof body.changeSummary !== "string")
  ) {
    return Response.json({ error: "Invalid artifact revision." }, { status: 400 });
  }
  const base = {
    artifactId: id,
    versionId: body.versionId,
    filename: body.filename,
    ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}),
    ...(typeof body.changeSummary === "string"
      ? { changeSummary: body.changeSummary }
      : {}),
    createdBy: "owner",
    createdFrom: "edit",
  };
  try {
    const artifact =
      typeof body.content === "string"
        ? await runApp(createArtifactVersion({ ...base, bytes: bytesFromText(body.content) }))
        : body.blob !== undefined &&
            typeof body.blob.url === "string" &&
            typeof body.blob.pathname === "string" &&
            typeof body.blob.size === "number" &&
            (body.blob.sha256 === undefined || typeof body.blob.sha256 === "string")
          ? await runApp(
              registerUploadedArtifactVersion({
                ...base,
                blobUrl: body.blob.url,
                blobPath: body.blob.pathname,
                sizeBytes: body.blob.size,
                ...(typeof body.blob.sha256 === "string"
                  ? { sha256: body.blob.sha256 }
                  : {}),
              }),
            )
          : null;
    if (artifact === null) {
      return Response.json({ error: "Provide text content or an uploaded Blob." }, { status: 400 });
    }
    return Response.json({ artifact }, { status: 201 });
  } catch (error) {
    return apiFailure(error);
  }
}
