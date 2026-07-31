import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { MAX_ARTIFACT_BYTES } from "@/agent/lib/effect/artifacts";
import { isUuid } from "@/lib/artifact-api";
import { requireWebAuth } from "@/lib/web-auth";

interface UploadPayload {
  artifactId?: unknown;
  versionId?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  if ((process.env.DATABASE_URL ?? "").trim().length === 0) {
    return Response.json(
      { error: "Artifact persistence is not configured." },
      { status: 503 },
    );
  }
  if ((process.env.BLOB_READ_WRITE_TOKEN ?? "").trim().length === 0) {
    return Response.json(
      { error: "A private Vercel Blob store is not configured." },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as HandleUploadBody | null;
  if (body === null) return Response.json({ error: "Invalid upload request." }, { status: 400 });

  try {
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = JSON.parse(clientPayload ?? "{}") as UploadPayload;
        if (!isUuid(payload.artifactId) || !isUuid(payload.versionId)) {
          throw new Error("Invalid artifact upload identity.");
        }
        const expectedPrefix = `artifacts/${payload.artifactId}/${payload.versionId}/`;
        if (!pathname.startsWith(expectedPrefix) || pathname.length > expectedPrefix.length + 180) {
          throw new Error("Invalid artifact upload pathname.");
        }
        return {
          allowedContentTypes: [
            "text/markdown",
            "text/html",
            "text/csv",
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/octet-stream",
          ],
          maximumSizeInBytes: MAX_ARTIFACT_BYTES,
          addRandomSuffix: false,
          allowOverwrite: false,
          tokenPayload: clientPayload,
        };
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not authorize upload." },
      { status: 400 },
    );
  }
}
