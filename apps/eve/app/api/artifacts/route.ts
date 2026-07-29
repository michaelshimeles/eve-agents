import {
  createArtifact,
  listArtifacts,
  registerUploadedArtifact,
} from "@/agent/lib/effect/artifacts";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  apiFailure,
  bytesFromText,
  isArtifactKind,
  isUuid,
} from "@/lib/artifact-api";
import { requireWebAuth } from "@/lib/web-auth";

interface CreateBody {
  artifactId?: unknown;
  versionId?: unknown;
  title?: unknown;
  filename?: unknown;
  mimeType?: unknown;
  kind?: unknown;
  content?: unknown;
  threadId?: unknown;
  blob?: {
    url?: unknown;
    pathname?: unknown;
    size?: unknown;
    sha256?: unknown;
  };
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const threadId = url.searchParams.get("threadId") ?? undefined;
  const query = url.searchParams.get("q") ?? undefined;
  try {
    const artifacts = await runApp(listArtifacts({ threadId, query }));
    return Response.json({ artifacts });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as CreateBody | null;
  if (
    body === null ||
    !isUuid(body.artifactId) ||
    !isUuid(body.versionId) ||
    typeof body.title !== "string" ||
    typeof body.filename !== "string" ||
    typeof body.mimeType !== "string" ||
    (body.kind !== undefined && !isArtifactKind(body.kind)) ||
    (body.threadId !== undefined && typeof body.threadId !== "string")
  ) {
    return Response.json({ error: "Invalid artifact." }, { status: 400 });
  }

  const base = {
    artifactId: body.artifactId,
    versionId: body.versionId,
    title: body.title,
    filename: body.filename,
    mimeType: body.mimeType,
    ...(body.kind === undefined ? {} : { kind: body.kind }),
    ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
    createdBy: "owner",
    createdFrom: "upload",
  };

  try {
    const artifact =
      typeof body.content === "string"
        ? await runApp(createArtifact({ ...base, bytes: bytesFromText(body.content) }))
        : body.blob !== undefined &&
            typeof body.blob.url === "string" &&
            typeof body.blob.pathname === "string" &&
            typeof body.blob.size === "number" &&
            (body.blob.sha256 === undefined || typeof body.blob.sha256 === "string")
          ? await runApp(
              registerUploadedArtifact({
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
