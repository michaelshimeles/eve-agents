import { defineDynamic, defineTool } from "eve/tools";
import { Effect, Schema } from "effect";

import {
  createArtifact,
  createArtifactShare,
  createArtifactVersion,
  getArtifactDetail,
  listArtifacts,
  readArtifactText,
} from "../lib/effect/artifacts";
import { runTool } from "../lib/effect/runtime";
import { toolSchema } from "../lib/effect/tool-schema";
import { ownerOnly } from "../lib/owner-gate";
import { webThreadId } from "../lib/web-client-context";

const CreateArtifactInput = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'Sandbox path, e.g. "/workspace/report.md".',
  }),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  mime_type: Schema.optionalKey(
    Schema.String.annotate({
      description: "MIME type. Inferred from the filename when omitted.",
    }),
  ),
  change_summary: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(500)).annotate({
      description: "Short description of what this first revision contains.",
    }),
  ),
});

const UpdateArtifactInput = Schema.Struct({
  artifact_id: Schema.String.annotate({ description: "Artifact id returned by an artifact tool." }),
  path: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Sandbox path containing the complete new revision.",
  }),
  change_summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  mime_type: Schema.optionalKey(Schema.String),
});

const ListArtifactsInput = Schema.Struct({
  query: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "Optional title or filename search.",
    }),
  ),
});

const ReadArtifactInput = Schema.Struct({
  artifact_id: Schema.String,
  version_id: Schema.optionalKey(
    Schema.String.annotate({ description: "Omit to read the current revision." }),
  ),
});

const ShareArtifactInput = Schema.Struct({
  artifact_id: Schema.String,
  version_id: Schema.optionalKey(
    Schema.String.annotate({ description: "Omit to share the current revision." }),
  ),
  expires_in_days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(7)),
  ),
});

function inferredMime(filename: string): string {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  if (extension === "md" || extension === "markdown") return "text/markdown";
  if (extension === "html" || extension === "htm") return "text/html";
  if (extension === "pdf") return "application/pdf";
  if (extension === "csv") return "text/csv";
  if (extension === "xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (extension === "pptx") {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  return "application/octet-stream";
}

function artifactToolsConfigured(): boolean {
  const database = (process.env.DATABASE_URL ?? "").trim().length > 0;
  const blob =
    (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim().length > 0 ||
    ((process.env.VERCEL_OIDC_TOKEN ?? "").trim().length > 0 &&
      (process.env.BLOB_STORE_ID ?? "").trim().length > 0);
  return database && blob;
}

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!artifactToolsConfigured()) return null;
      const threadId = webThreadId(ctx.messages);
      return {
        artifact_create: defineTool({
          approval: ownerOnly,
          description:
            "Save a sandbox file as a durable artifact in the user's workspace. Use for PDFs, Markdown, HTML, CSV/XLSX spreadsheets, and PPTX presentations you create or materially transform. The first call creates revision 1; use artifact_update for later revisions.",
          inputSchema: toolSchema(CreateArtifactInput),
          async execute({ path, title, mime_type, change_summary }, ctx) {
            const sandbox = await ctx.getSandbox();
            const bytes = await sandbox.readBinaryFile({ path });
            if (bytes === null) {
              throw new Error(`No file at ${sandbox.resolvePath(path)}.`);
            }
            const filename = path.split("/").filter(Boolean).at(-1) ?? "artifact";
            const artifact = await runTool(
              createArtifact({
                title,
                filename,
                mimeType: mime_type ?? inferredMime(filename),
                bytes,
                ...(threadId === null ? {} : { threadId }),
                sessionId: ctx.session.id,
                createdBy: "agent",
                createdFrom: "agent",
                ...(change_summary === undefined ? {} : { changeSummary: change_summary }),
              }),
            );
            return {
              artifactId: artifact.id,
              versionId: artifact.currentVersionId,
              revision: artifact.currentVersion.ordinal,
              title: artifact.title,
              kind: artifact.kind,
              sizeBytes: artifact.currentVersion.sizeBytes,
              openUrl: `/?artifact=${artifact.id}&workspace=artifacts`,
              downloadUrl: `/api/artifacts/${artifact.id}/content?download=1`,
              note: "Saved to the Artifacts workspace. Link the openUrl in your reply.",
            };
          },
        }),

        artifact_update: defineTool({
          approval: ownerOnly,
          description:
            "Save a complete sandbox file as a new immutable revision of an existing artifact. Never overwrite an earlier revision.",
          inputSchema: toolSchema(UpdateArtifactInput),
          async execute({ artifact_id, path, change_summary, mime_type }, ctx) {
            const sandbox = await ctx.getSandbox();
            const bytes = await sandbox.readBinaryFile({ path });
            if (bytes === null) {
              throw new Error(`No file at ${sandbox.resolvePath(path)}.`);
            }
            const filename = path.split("/").filter(Boolean).at(-1) ?? "artifact";
            const artifact = await runTool(
              createArtifactVersion({
                artifactId: artifact_id,
                filename,
                ...(mime_type === undefined ? {} : { mimeType: mime_type }),
                bytes,
                createdBy: "agent",
                createdFrom: "agent",
                changeSummary: change_summary,
              }),
            );
            return {
              artifactId: artifact.id,
              versionId: artifact.currentVersionId,
              revision: artifact.currentVersion.ordinal,
              title: artifact.title,
              sizeBytes: artifact.currentVersion.sizeBytes,
              openUrl: `/?artifact=${artifact.id}&workspace=artifacts`,
              downloadUrl: `/api/artifacts/${artifact.id}/content?download=1`,
            };
          },
        }),

        artifact_list: defineTool({
          approval: ownerOnly,
          description:
            "List durable artifacts in the workspace, newest first. Use this to find an artifact id before reading or revising it.",
          inputSchema: toolSchema(ListArtifactsInput),
          execute({ query }) {
            return runTool(
              listArtifacts(query === undefined ? undefined : { query }),
            ).then((artifacts) => ({
              artifacts: artifacts.slice(0, 50).map((artifact) => ({
                artifactId: artifact.id,
                versionId: artifact.currentVersionId,
                revision: artifact.currentVersion.ordinal,
                title: artifact.title,
                kind: artifact.kind,
                filename: artifact.currentVersion.filename,
                sizeBytes: artifact.currentVersion.sizeBytes,
                updatedAt: artifact.updatedAt,
              })),
            }));
          },
        }),

        artifact_read: defineTool({
          approval: ownerOnly,
          description:
            "Read a Markdown, HTML, or other text artifact revision. For binary formats, use the sandbox source you created or ask the user which revision to transform.",
          inputSchema: toolSchema(ReadArtifactInput),
          execute({ artifact_id, version_id }) {
            return runTool(
              readArtifactText(artifact_id, version_id),
            ).then((content) => ({ content }));
          },
        }),

        artifact_share: defineTool({
          approval: ownerOnly,
          description:
            "Create a revocable public link to one exact immutable artifact revision. The default expiry is seven days. This is externally accessible, so use only when the user asks to share or needs a download link outside the signed-in workspace.",
          inputSchema: toolSchema(ShareArtifactInput),
          async execute({ artifact_id, version_id, expires_in_days }) {
            const detail = await runTool(getArtifactDetail(artifact_id));
            const selectedVersionId = version_id ?? detail.artifact.currentVersionId;
            const { share, token } = await runTool(
              createArtifactShare({
                artifactId: artifact_id,
                versionId: selectedVersionId,
                expiresInDays: expires_in_days,
              }),
            );
            const origin =
              process.env.NEXT_PUBLIC_APP_URL ??
              (process.env.VERCEL_PROJECT_PRODUCTION_URL
                ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
                : "");
            return {
              artifactId: artifact_id,
              versionId: selectedVersionId,
              url: `${origin}/share/${token}`,
              expiresAt: share.expiresAt,
              note: "Anyone with this link can access this exact revision until it expires or is revoked.",
            };
          },
        }),
      };
    },
  },
});
