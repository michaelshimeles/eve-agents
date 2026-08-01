import { createHash, randomBytes, randomUUID } from "node:crypto";

import { copy, get, head, put } from "@vercel/blob";
import type { GetBlobResult } from "@vercel/blob";
import { Context, Data, Effect, Layer, Schema } from "effect";
import type { SchemaError } from "effect/SchemaError";

import { type DatabaseError, Db } from "./db";

export const ARTIFACT_WORKSPACE_ID = "default";
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export const ARTIFACT_KINDS = [
  "markdown",
  "html",
  "pdf",
  "spreadsheet",
  "presentation",
  "file",
] as const;

export const ArtifactKind = Schema.Literals(ARTIFACT_KINDS);
export type ArtifactKind = typeof ArtifactKind.Type;

export const ArtifactVersion = Schema.Struct({
  id: Schema.String,
  artifactId: Schema.String,
  ordinal: Schema.Int,
  filename: Schema.String,
  blobUrl: Schema.String,
  blobPath: Schema.String,
  sizeBytes: Schema.Int,
  sha256: Schema.NullOr(Schema.String),
  createdFrom: Schema.String,
  changeSummary: Schema.NullOr(Schema.String),
  createdBy: Schema.String,
  createdAt: Schema.String,
});
export type ArtifactVersion = typeof ArtifactVersion.Type;

export const ArtifactDescriptor = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  title: Schema.String,
  kind: ArtifactKind,
  mimeType: Schema.String,
  currentVersionId: Schema.String,
  originThreadId: Schema.NullOr(Schema.String),
  originSessionId: Schema.NullOr(Schema.String),
  createdBy: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  currentVersion: ArtifactVersion,
});
export type ArtifactDescriptor = typeof ArtifactDescriptor.Type;

export const ArtifactComment = Schema.Struct({
  id: Schema.String,
  artifactId: Schema.String,
  versionId: Schema.String,
  body: Schema.String,
  selection: Schema.NullOr(Schema.Unknown),
  createdBy: Schema.String,
  createdAt: Schema.String,
});
export type ArtifactComment = typeof ArtifactComment.Type;

export const ArtifactShare = Schema.Struct({
  id: Schema.String,
  artifactId: Schema.String,
  versionId: Schema.String,
  expiresAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type ArtifactShare = typeof ArtifactShare.Type;

export interface ArtifactDetail {
  readonly artifact: ArtifactDescriptor;
  readonly versions: readonly ArtifactVersion[];
  readonly comments: readonly ArtifactComment[];
}

export interface CreateArtifactInput {
  readonly artifactId?: string;
  readonly versionId?: string;
  readonly title: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly kind?: ArtifactKind;
  readonly bytes: Uint8Array;
  readonly threadId?: string;
  readonly sessionId?: string;
  readonly createdBy: string;
  readonly createdFrom: string;
  readonly changeSummary?: string;
}

export interface RegisterUploadedArtifactInput
  extends Omit<CreateArtifactInput, "bytes"> {
  readonly blobUrl: string;
  readonly blobPath: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
}

export interface CreateVersionInput {
  readonly artifactId: string;
  readonly versionId?: string;
  readonly filename: string;
  readonly mimeType?: string;
  readonly bytes: Uint8Array;
  readonly createdBy: string;
  readonly createdFrom: string;
  readonly changeSummary?: string;
}

export interface RegisterUploadedVersionInput
  extends Omit<CreateVersionInput, "bytes"> {
  readonly blobUrl: string;
  readonly blobPath: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
}

export class ArtifactError extends Data.TaggedError("ArtifactError")<{
  readonly code:
    | "not_configured"
    | "not_found"
    | "invalid_file"
    | "storage_failed"
    | "conflict";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function describeArtifactError(error: ArtifactError): string {
  return error.message;
}

export type ArtifactsError = ArtifactError | DatabaseError | SchemaError;

const VersionProjection = `
  v.id,
  v.artifact_id AS "artifactId",
  v.ordinal,
  v.filename,
  v.blob_url AS "blobUrl",
  v.blob_path AS "blobPath",
  v.size_bytes::int AS "sizeBytes",
  v.sha256,
  v.created_from AS "createdFrom",
  v.change_summary AS "changeSummary",
  v.created_by AS "createdBy",
  v.created_at::text AS "createdAt"
`;

const DescriptorProjection = `
  a.id,
  a.workspace_id AS "workspaceId",
  a.title,
  a.kind,
  a.mime_type AS "mimeType",
  a.current_version_id AS "currentVersionId",
  a.origin_thread_id AS "originThreadId",
  a.origin_session_id AS "originSessionId",
  a.created_by AS "createdBy",
  a.created_at::text AS "createdAt",
  a.updated_at::text AS "updatedAt",
  jsonb_build_object(
    'id', v.id,
    'artifactId', v.artifact_id,
    'ordinal', v.ordinal,
    'filename', v.filename,
    'blobUrl', v.blob_url,
    'blobPath', v.blob_path,
    'sizeBytes', v.size_bytes::int,
    'sha256', v.sha256,
    'createdFrom', v.created_from,
    'changeSummary', v.change_summary,
    'createdBy', v.created_by,
    'createdAt', v.created_at::text
  ) AS "currentVersion"
`;

function storageConfigured(): boolean {
  return (
    (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim().length > 0 ||
    ((process.env.VERCEL_OIDC_TOKEN ?? "").trim().length > 0 &&
      (process.env.BLOB_STORE_ID ?? "").trim().length > 0)
  );
}

function databaseConfigured(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

function requireConfigured(): Effect.Effect<void, ArtifactError> {
  if (!databaseConfigured() || !storageConfigured()) {
    return Effect.fail(
      new ArtifactError({
        code: "not_configured",
        message:
          "Artifacts need DATABASE_URL and a private Vercel Blob store (BLOB_READ_WRITE_TOKEN, or Vercel OIDC plus BLOB_STORE_ID).",
      }),
    );
  }
  return Effect.void;
}

function safeFilename(filename: string): string {
  const cleaned = filename
    .normalize("NFKC")
    .replaceAll(/[/\\\u0000-\u001f\u007f]/g, "-")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned.length > 0 ? cleaned : "artifact";
}

function artifactPath(
  artifactId: string,
  versionId: string,
  filename: string,
): string {
  return `artifacts/${artifactId}/${versionId}/${safeFilename(filename)}`;
}

function validateSize(sizeBytes: number): Effect.Effect<void, ArtifactError> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_ARTIFACT_BYTES) {
    return Effect.fail(
      new ArtifactError({
        code: "invalid_file",
        message: `Artifacts must be no larger than ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB.`,
      }),
    );
  }
  return Effect.void;
}

function validateUploadedPath(
  artifactId: string,
  versionId: string,
  pathname: string,
): Effect.Effect<void, ArtifactError> {
  const prefix = `artifacts/${artifactId}/${versionId}/`;
  if (!pathname.startsWith(prefix)) {
    return Effect.fail(
      new ArtifactError({
        code: "invalid_file",
        message: "The uploaded Blob pathname does not match this artifact revision.",
      }),
    );
  }
  return Effect.void;
}

function storageTry<A>(
  operation: () => Promise<A>,
  message: string,
): Effect.Effect<A, ArtifactError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new ArtifactError({ code: "storage_failed", message, cause }),
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function shareHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function inferArtifactKind(filename: string, mimeType: string): ArtifactKind {
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = mimeType.toLowerCase();
  if (extension === "md" || extension === "markdown" || mime === "text/markdown") {
    return "markdown";
  }
  if (extension === "html" || extension === "htm" || mime === "text/html") {
    return "html";
  }
  if (extension === "pdf" || mime === "application/pdf") return "pdf";
  if (
    extension === "csv" ||
    extension === "xlsx" ||
    mime === "text/csv" ||
    mime.includes("spreadsheet") ||
    mime.includes("excel")
  ) {
    return "spreadsheet";
  }
  if (
    extension === "pptx" ||
    mime.includes("presentation") ||
    mime.includes("powerpoint")
  ) {
    return "presentation";
  }
  return "file";
}

function mimeForKind(kind: ArtifactKind, fallback: string): string {
  if (kind === "markdown") return "text/markdown";
  if (kind === "html") return "text/html";
  return fallback || "application/octet-stream";
}

export class Artifacts extends Context.Service<Artifacts, {
  readonly list: (input?: {
    readonly threadId?: string;
    readonly query?: string;
  }) => Effect.Effect<readonly ArtifactDescriptor[], ArtifactsError>;
  readonly detail: (id: string) => Effect.Effect<ArtifactDetail, ArtifactsError>;
  readonly create: (input: CreateArtifactInput) => Effect.Effect<ArtifactDescriptor, ArtifactsError>;
  readonly registerUploaded: (
    input: RegisterUploadedArtifactInput,
  ) => Effect.Effect<ArtifactDescriptor, ArtifactsError>;
  readonly createVersion: (
    input: CreateVersionInput,
  ) => Effect.Effect<ArtifactDescriptor, ArtifactsError>;
  readonly registerUploadedVersion: (
    input: RegisterUploadedVersionInput,
  ) => Effect.Effect<ArtifactDescriptor, ArtifactsError>;
  readonly rename: (
    id: string,
    title: string,
  ) => Effect.Effect<ArtifactDescriptor, ArtifactsError>;
  readonly remove: (id: string) => Effect.Effect<{ readonly deleted: boolean }, ArtifactsError>;
  readonly version: (
    artifactId: string,
    versionId?: string,
  ) => Effect.Effect<ArtifactVersion, ArtifactsError>;
  readonly readText: (
    artifactId: string,
    versionId?: string,
  ) => Effect.Effect<string, ArtifactsError>;
  readonly openContent: (
    artifactId: string,
    versionId?: string,
  ) => Effect.Effect<{ readonly version: ArtifactVersion; readonly blob: GetBlobResult }, ArtifactsError>;
  readonly getDraft: (
    artifactId: string,
  ) => Effect.Effect<{ readonly content: string; readonly updatedAt: string } | null, ArtifactsError>;
  readonly saveDraft: (
    artifactId: string,
    content: string,
  ) => Effect.Effect<{ readonly content: string; readonly updatedAt: string }, ArtifactsError>;
  readonly deleteDraft: (artifactId: string) => Effect.Effect<void, ArtifactsError>;
  readonly addComment: (input: {
    readonly artifactId: string;
    readonly versionId: string;
    readonly body: string;
    readonly selection?: unknown;
    readonly createdBy: string;
  }) => Effect.Effect<ArtifactComment, ArtifactsError>;
  readonly createShare: (input: {
    readonly artifactId: string;
    readonly versionId: string;
    readonly expiresInDays: number;
  }) => Effect.Effect<{ readonly share: ArtifactShare; readonly token: string }, ArtifactsError>;
  readonly revokeShare: (
    artifactId: string,
    shareId: string,
  ) => Effect.Effect<{ readonly revoked: boolean }, ArtifactsError>;
  readonly listShares: (
    artifactId: string,
  ) => Effect.Effect<readonly ArtifactShare[], ArtifactsError>;
  readonly resolveShare: (
    token: string,
  ) => Effect.Effect<{ readonly artifact: ArtifactDescriptor; readonly version: ArtifactVersion }, ArtifactsError>;
  readonly restore: (
    artifactId: string,
    versionId: string,
    createdBy: string,
  ) => Effect.Effect<ArtifactDescriptor, ArtifactsError>;
}>()("Artifacts") {}

export const ArtifactsLive = Layer.effect(
  Artifacts,
  Effect.gen(function* () {
    const database = yield* Db;
    let ensured = false;

    const decodeDescriptors = Schema.decodeUnknownEffect(Schema.Array(ArtifactDescriptor));
    const decodeVersions = Schema.decodeUnknownEffect(Schema.Array(ArtifactVersion));
    const decodeComments = Schema.decodeUnknownEffect(Schema.Array(ArtifactComment));
    const decodeShares = Schema.decodeUnknownEffect(Schema.Array(ArtifactShare));

    const ensure = Effect.gen(function* () {
      yield* requireConfigured();
      if (ensured) return;
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id text PRIMARY KEY,
          workspace_id text NOT NULL DEFAULT 'default',
          title text NOT NULL,
          kind text NOT NULL,
          mime_type text NOT NULL,
          current_version_id text NOT NULL,
          origin_thread_id text,
          origin_session_id text,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz
        )
      `);
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS artifact_versions (
          id text PRIMARY KEY,
          artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          ordinal integer NOT NULL,
          filename text NOT NULL,
          blob_url text NOT NULL,
          blob_path text NOT NULL,
          size_bytes bigint NOT NULL,
          sha256 text,
          created_from text NOT NULL,
          change_summary text,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (artifact_id, ordinal)
        )
      `);
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS artifact_thread_links (
          artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          thread_id text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (artifact_id, thread_id)
        )
      `);
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS artifact_drafts (
          artifact_id text PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
          content text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS artifact_comments (
          id text PRIMARY KEY,
          artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          version_id text NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
          body text NOT NULL,
          selection jsonb,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS artifact_shares (
          id text PRIMARY KEY,
          artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          version_id text NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
          token_hash text NOT NULL UNIQUE,
          expires_at timestamptz NOT NULL,
          revoked_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      yield* database.query(
        "CREATE INDEX IF NOT EXISTS artifacts_updated_idx ON artifacts (updated_at DESC) WHERE deleted_at IS NULL",
      );
      yield* database.query(
        "CREATE INDEX IF NOT EXISTS artifact_thread_links_thread_idx ON artifact_thread_links (thread_id, created_at DESC)",
      );
      ensured = true;
    });

    const list = (input: { readonly threadId?: string; readonly query?: string } = {}) =>
      Effect.gen(function* () {
        yield* ensure;
        const params: unknown[] = [ARTIFACT_WORKSPACE_ID];
        const where = ["a.workspace_id = $1", "a.deleted_at IS NULL"];
        let join = "";
        if (input.threadId !== undefined) {
          params.push(input.threadId);
          join = "JOIN artifact_thread_links atl ON atl.artifact_id = a.id";
          where.push(`atl.thread_id = $${params.length}`);
        }
        if (input.query !== undefined && input.query.trim().length > 0) {
          params.push(`%${input.query.trim()}%`);
          where.push(`(a.title ILIKE $${params.length} OR v.filename ILIKE $${params.length})`);
        }
        const rows = yield* database.query(
          `SELECT ${DescriptorProjection}
             FROM artifacts a
             JOIN artifact_versions v ON v.id = a.current_version_id
             ${join}
            WHERE ${where.join(" AND ")}
            ORDER BY a.updated_at DESC`,
          params,
        );
        return yield* decodeDescriptors(rows);
      });

    const descriptor = (id: string) =>
      Effect.gen(function* () {
        yield* ensure;
        const rows = yield* database.query(
          `SELECT ${DescriptorProjection}
             FROM artifacts a
             JOIN artifact_versions v ON v.id = a.current_version_id
            WHERE a.id = $1 AND a.deleted_at IS NULL`,
          [id],
        );
        const artifacts = yield* decodeDescriptors(rows);
        const artifact = artifacts[0];
        if (artifact === undefined) {
          return yield* Effect.fail(
            new ArtifactError({ code: "not_found", message: "Artifact not found." }),
          );
        }
        return artifact;
      });

    const version = (artifactId: string, versionId?: string) =>
      Effect.gen(function* () {
        yield* ensure;
        const params = versionId === undefined ? [artifactId] : [artifactId, versionId];
        const predicate =
          versionId === undefined
            ? "v.id = a.current_version_id"
            : "v.id = $2";
        const rows = yield* database.query(
          `SELECT ${VersionProjection}
             FROM artifact_versions v
             JOIN artifacts a ON a.id = v.artifact_id
            WHERE v.artifact_id = $1 AND ${predicate} AND a.deleted_at IS NULL`,
          params,
        );
        const versions = yield* decodeVersions(rows);
        const found = versions[0];
        if (found === undefined) {
          return yield* Effect.fail(
            new ArtifactError({ code: "not_found", message: "Artifact revision not found." }),
          );
        }
        return found;
      });

    const insertArtifact = (input: RegisterUploadedArtifactInput) =>
      Effect.gen(function* () {
        const artifactId = input.artifactId ?? randomUUID();
        const versionId = input.versionId ?? randomUUID();
        const kind = input.kind ?? inferArtifactKind(input.filename, input.mimeType);
        const mimeType = mimeForKind(kind, input.mimeType);
        yield* validateSize(input.sizeBytes);
        yield* validateUploadedPath(artifactId, versionId, input.blobPath);
        const rows = yield* database.query(
          `WITH inserted_artifact AS (
             INSERT INTO artifacts (
               id, workspace_id, title, kind, mime_type, current_version_id,
               origin_thread_id, origin_session_id, created_by
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id
           ), inserted_version AS (
             INSERT INTO artifact_versions (
               id, artifact_id, ordinal, filename, blob_url, blob_path, size_bytes,
               sha256, created_from, change_summary, created_by
             )
             SELECT $6, id, 1, $10, $11, $12, $13, $14, $15, $16, $9
             FROM inserted_artifact
             RETURNING id
           )
           SELECT id FROM inserted_version`,
          [
            artifactId,
            ARTIFACT_WORKSPACE_ID,
            input.title.trim().slice(0, 240) || safeFilename(input.filename),
            kind,
            mimeType,
            versionId,
            input.threadId ?? null,
            input.sessionId ?? null,
            input.createdBy,
            safeFilename(input.filename),
            input.blobUrl,
            input.blobPath,
            input.sizeBytes,
            input.sha256 ?? null,
            input.createdFrom,
            input.changeSummary ?? null,
          ],
        );
        if (rows.length === 0) {
          return yield* Effect.fail(
            new ArtifactError({ code: "conflict", message: "Could not create artifact." }),
          );
        }
        if (input.threadId !== undefined) {
          yield* database.query(
            `INSERT INTO artifact_thread_links (artifact_id, thread_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [artifactId, input.threadId],
          );
        }
        return yield* descriptor(artifactId);
      });

    const verifyUpload = (input: {
      readonly artifactId: string;
      readonly versionId: string;
      readonly blobUrl: string;
      readonly blobPath: string;
      readonly sizeBytes: number;
    }) =>
      Effect.gen(function* () {
        yield* validateUploadedPath(input.artifactId, input.versionId, input.blobPath);
        yield* validateSize(input.sizeBytes);
        const metadata = yield* storageTry(
          () => head(input.blobUrl),
          "Could not verify the uploaded artifact in private Blob storage.",
        );
        if (
          metadata.pathname !== input.blobPath ||
          metadata.size !== input.sizeBytes ||
          !metadata.url.includes(".private.blob.vercel-storage.com/")
        ) {
          return yield* Effect.fail(
            new ArtifactError({
              code: "invalid_file",
              message: "The uploaded Blob metadata does not match this artifact revision.",
            }),
          );
        }
      });

    const insertVersion = (input: RegisterUploadedVersionInput) =>
      Effect.gen(function* () {
        yield* ensure;
        const current = yield* descriptor(input.artifactId);
        const versionId = input.versionId ?? randomUUID();
        yield* validateUploadedPath(input.artifactId, versionId, input.blobPath);
        yield* validateSize(input.sizeBytes);
        const nextKind = inferArtifactKind(
          input.filename,
          input.mimeType ?? current.mimeType,
        );
        const results = yield* database.transaction([
          {
            // Serializes revision writers for one artifact. Because the next
            // query is a separate command in the same READ COMMITTED
            // transaction, a waiter sees the revision committed by the writer
            // that released this row lock before it computes max(ordinal).
            sql: `SELECT id
                    FROM artifacts
                   WHERE id = $1 AND deleted_at IS NULL
                   FOR UPDATE`,
            params: [input.artifactId],
          },
          {
            sql: `INSERT INTO artifact_versions (
                    id, artifact_id, ordinal, filename, blob_url, blob_path,
                    size_bytes, sha256, created_from, change_summary, created_by
                  )
                  SELECT $1, a.id, coalesce(max(v.ordinal), 0)::int + 1,
                         $3, $4, $5, $6, $7, $8, $9, $10
                    FROM artifacts a
                    LEFT JOIN artifact_versions v ON v.artifact_id = a.id
                   WHERE a.id = $2 AND a.deleted_at IS NULL
                   GROUP BY a.id
                  RETURNING id`,
            params: [
              versionId,
              input.artifactId,
              safeFilename(input.filename),
              input.blobUrl,
              input.blobPath,
              input.sizeBytes,
              input.sha256 ?? null,
              input.createdFrom,
              input.changeSummary ?? null,
              input.createdBy,
            ],
          },
          {
            sql: `UPDATE artifacts
                     SET current_version_id = $1,
                         mime_type = coalesce($3, mime_type),
                         kind = $4,
                         updated_at = now()
                   WHERE id = $2
                     AND deleted_at IS NULL
                     AND EXISTS (
                       SELECT 1 FROM artifact_versions WHERE id = $1
                     )
                  RETURNING id`,
            params: [
              versionId,
              input.artifactId,
              input.mimeType ?? null,
              nextKind,
            ],
          },
          {
            sql: `DELETE FROM artifact_drafts
                   WHERE artifact_id = $1
                     AND EXISTS (
                       SELECT 1 FROM artifact_versions WHERE id = $2
                     )`,
            params: [input.artifactId, versionId],
          },
        ]);
        if ((results[0]?.length ?? 0) === 0) {
          return yield* Effect.fail(
            new ArtifactError({ code: "not_found", message: "Artifact not found." }),
          );
        }
        if ((results[1]?.length ?? 0) === 0 || (results[2]?.length ?? 0) === 0) {
          return yield* Effect.fail(
            new ArtifactError({
              code: "conflict",
              message: "Could not create the artifact revision.",
            }),
          );
        }
        return yield* descriptor(input.artifactId);
      });

    return {
      list,

      detail: (id) =>
        Effect.gen(function* () {
          const artifact = yield* descriptor(id);
          const [versionRows, commentRows] = yield* Effect.all(
            [
              database.query(
                `SELECT ${VersionProjection}
                   FROM artifact_versions v
                  WHERE v.artifact_id = $1
                  ORDER BY v.ordinal DESC`,
                [id],
              ),
              database.query(
                `SELECT id, artifact_id AS "artifactId", version_id AS "versionId",
                        body, selection, created_by AS "createdBy",
                        created_at::text AS "createdAt"
                   FROM artifact_comments
                  WHERE artifact_id = $1
                  ORDER BY created_at DESC`,
                [id],
              ),
            ],
            { concurrency: "unbounded" },
          );
          return {
            artifact,
            versions: yield* decodeVersions(versionRows),
            comments: yield* decodeComments(commentRows),
          };
        }),

      create: (input) =>
        Effect.gen(function* () {
          yield* ensure;
          yield* validateSize(input.bytes.byteLength);
          const artifactId = input.artifactId ?? randomUUID();
          const versionId = input.versionId ?? randomUUID();
          const pathname = artifactPath(artifactId, versionId, input.filename);
          const blob = yield* storageTry(
            () =>
              put(pathname, Buffer.from(input.bytes), {
                access: "private",
                addRandomSuffix: false,
                contentType: input.mimeType,
              }),
            "Could not save the artifact to private Blob storage.",
          );
          return yield* insertArtifact({
            ...input,
            artifactId,
            versionId,
            blobUrl: blob.url,
            blobPath: blob.pathname,
            sizeBytes: input.bytes.byteLength,
            sha256: sha256(input.bytes),
          });
        }),

      registerUploaded: (input) =>
        Effect.gen(function* () {
          yield* ensure;
          const artifactId = input.artifactId ?? randomUUID();
          const versionId = input.versionId ?? randomUUID();
          yield* verifyUpload({
            artifactId,
            versionId,
            blobUrl: input.blobUrl,
            blobPath: input.blobPath,
            sizeBytes: input.sizeBytes,
          });
          return yield* insertArtifact({ ...input, artifactId, versionId });
        }),

      createVersion: (input) =>
        Effect.gen(function* () {
          yield* ensure;
          yield* validateSize(input.bytes.byteLength);
          const versionId = input.versionId ?? randomUUID();
          const pathname = artifactPath(input.artifactId, versionId, input.filename);
          const blob = yield* storageTry(
            () =>
              put(pathname, Buffer.from(input.bytes), {
                access: "private",
                addRandomSuffix: false,
                contentType: input.mimeType,
              }),
            "Could not save the artifact revision to private Blob storage.",
          );
          return yield* insertVersion({
            ...input,
            versionId,
            blobUrl: blob.url,
            blobPath: blob.pathname,
            sizeBytes: input.bytes.byteLength,
            sha256: sha256(input.bytes),
          });
        }),

      registerUploadedVersion: (input) =>
        Effect.gen(function* () {
          yield* ensure;
          const versionId = input.versionId ?? randomUUID();
          yield* verifyUpload({
            artifactId: input.artifactId,
            versionId,
            blobUrl: input.blobUrl,
            blobPath: input.blobPath,
            sizeBytes: input.sizeBytes,
          });
          return yield* insertVersion({ ...input, versionId });
        }),

      rename: (id, title) =>
        Effect.gen(function* () {
          yield* ensure;
          const next = title.trim();
          if (next.length === 0 || next.length > 240) {
            return yield* Effect.fail(
              new ArtifactError({
                code: "invalid_file",
                message: "Artifact titles must be between 1 and 240 characters.",
              }),
            );
          }
          const rows = yield* database.query(
            `UPDATE artifacts SET title = $2, updated_at = now()
              WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
            [id, next],
          );
          if (rows.length === 0) {
            return yield* Effect.fail(
              new ArtifactError({ code: "not_found", message: "Artifact not found." }),
            );
          }
          return yield* descriptor(id);
        }),

      remove: (id) =>
        Effect.gen(function* () {
          yield* ensure;
          const rows = yield* database.query(
            `UPDATE artifacts SET deleted_at = now(), updated_at = now()
              WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
            [id],
          );
          return { deleted: rows.length > 0 };
        }),

      version,

      readText: (artifactId, versionId) =>
        Effect.gen(function* () {
          const selected = yield* version(artifactId, versionId);
          if (selected.sizeBytes > 5 * 1024 * 1024) {
            return yield* Effect.fail(
              new ArtifactError({
                code: "invalid_file",
                message: "This revision is too large to read as text.",
              }),
            );
          }
          const result = yield* storageTry(
            () => get(selected.blobUrl, { access: "private" }),
            "Could not read the artifact from private Blob storage.",
          );
          if (result === null || result.statusCode !== 200) {
            return yield* Effect.fail(
              new ArtifactError({ code: "not_found", message: "Artifact content not found." }),
            );
          }
          return yield* storageTry(
            () => new Response(result.stream).text(),
            "Could not decode the artifact as text.",
          );
        }),

      openContent: (artifactId, versionId) =>
        Effect.gen(function* () {
          const selected = yield* version(artifactId, versionId);
          const result = yield* storageTry(
            () => get(selected.blobUrl, { access: "private" }),
            "Could not read the artifact from private Blob storage.",
          );
          if (result === null || result.statusCode !== 200) {
            return yield* Effect.fail(
              new ArtifactError({ code: "not_found", message: "Artifact content not found." }),
            );
          }
          return { version: selected, blob: result };
        }),

      getDraft: (artifactId) =>
        Effect.gen(function* () {
          yield* descriptor(artifactId);
          const rows = yield* database.query(
            `SELECT content, updated_at::text AS "updatedAt"
               FROM artifact_drafts WHERE artifact_id = $1`,
            [artifactId],
          );
          const row = rows[0];
          return row === undefined
            ? null
            : { content: String(row.content), updatedAt: String(row.updatedAt) };
        }),

      saveDraft: (artifactId, content) =>
        Effect.gen(function* () {
          const artifact = yield* descriptor(artifactId);
          if (artifact.kind !== "markdown" && artifact.kind !== "html") {
            return yield* Effect.fail(
              new ArtifactError({
                code: "invalid_file",
                message: "Only Markdown and HTML artifacts have editable drafts.",
              }),
            );
          }
          if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) {
            return yield* Effect.fail(
              new ArtifactError({
                code: "invalid_file",
                message: "Editable artifacts are limited to 5 MB of text.",
              }),
            );
          }
          const rows = yield* database.query(
            `INSERT INTO artifact_drafts (artifact_id, content)
             VALUES ($1, $2)
             ON CONFLICT (artifact_id) DO UPDATE
               SET content = EXCLUDED.content, updated_at = now()
             RETURNING content, updated_at::text AS "updatedAt"`,
            [artifactId, content],
          );
          return { content: String(rows[0].content), updatedAt: String(rows[0].updatedAt) };
        }),

      deleteDraft: (artifactId) =>
        Effect.gen(function* () {
          yield* ensure;
          yield* database.query("DELETE FROM artifact_drafts WHERE artifact_id = $1", [
            artifactId,
          ]);
        }),

      addComment: (input) =>
        Effect.gen(function* () {
          yield* ensure;
          const body = input.body.trim();
          if (body.length === 0 || body.length > 4000) {
            return yield* Effect.fail(
              new ArtifactError({
                code: "invalid_file",
                message: "Comments must be between 1 and 4,000 characters.",
              }),
            );
          }
          const rows = yield* database.query(
            `INSERT INTO artifact_comments (
               id, artifact_id, version_id, body, selection, created_by
             )
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             RETURNING id, artifact_id AS "artifactId", version_id AS "versionId",
                       body, selection, created_by AS "createdBy",
                       created_at::text AS "createdAt"`,
            [
              randomUUID(),
              input.artifactId,
              input.versionId,
              body,
              input.selection === undefined ? null : JSON.stringify(input.selection),
              input.createdBy,
            ],
          );
          return (yield* decodeComments(rows))[0];
        }),

      createShare: (input) =>
        Effect.gen(function* () {
          yield* ensure;
          yield* version(input.artifactId, input.versionId);
          const days = Math.min(Math.max(Math.round(input.expiresInDays), 1), 30);
          const token = randomBytes(32).toString("base64url");
          const rows = yield* database.query(
            `INSERT INTO artifact_shares (
               id, artifact_id, version_id, token_hash, expires_at
             )
             VALUES ($1, $2, $3, $4, now() + ($5::text || ' days')::interval)
             RETURNING id, artifact_id AS "artifactId", version_id AS "versionId",
                       expires_at::text AS "expiresAt", revoked_at::text AS "revokedAt",
                       created_at::text AS "createdAt"`,
            [randomUUID(), input.artifactId, input.versionId, shareHash(token), days],
          );
          return { share: (yield* decodeShares(rows))[0], token };
        }),

      revokeShare: (artifactId, shareId) =>
        Effect.gen(function* () {
          yield* ensure;
          const rows = yield* database.query(
            `UPDATE artifact_shares SET revoked_at = now()
              WHERE id = $1 AND artifact_id = $2 AND revoked_at IS NULL
              RETURNING id`,
            [shareId, artifactId],
          );
          return { revoked: rows.length > 0 };
        }),

      listShares: (artifactId) =>
        Effect.gen(function* () {
          yield* ensure;
          const rows = yield* database.query(
            `SELECT id, artifact_id AS "artifactId", version_id AS "versionId",
                    expires_at::text AS "expiresAt", revoked_at::text AS "revokedAt",
                    created_at::text AS "createdAt"
               FROM artifact_shares
              WHERE artifact_id = $1
              ORDER BY created_at DESC`,
            [artifactId],
          );
          return yield* decodeShares(rows);
        }),

      resolveShare: (token) =>
        Effect.gen(function* () {
          yield* ensure;
          const rows = yield* database.query(
            `SELECT artifact_id AS "artifactId", version_id AS "versionId"
               FROM artifact_shares
              WHERE token_hash = $1
                AND revoked_at IS NULL
                AND expires_at > now()`,
            [shareHash(token)],
          );
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.fail(
              new ArtifactError({
                code: "not_found",
                message: "This artifact share is invalid, expired, or revoked.",
              }),
            );
          }
          const artifact = yield* descriptor(String(row.artifactId));
          const selected = yield* version(artifact.id, String(row.versionId));
          return { artifact, version: selected };
        }),

      restore: (artifactId, versionId, createdBy) =>
        Effect.gen(function* () {
          yield* ensure;
          const selected = yield* version(artifactId, versionId);
          const nextId = randomUUID();
          const nextPath = artifactPath(artifactId, nextId, selected.filename);
          const copied = yield* storageTry(
            () =>
              copy(selected.blobUrl, nextPath, {
                access: "private",
                contentType: undefined,
              }),
            "Could not copy the selected revision in private Blob storage.",
          );
          return yield* insertVersion({
            artifactId,
            versionId: nextId,
            filename: selected.filename,
            blobUrl: copied.url,
            blobPath: copied.pathname,
            sizeBytes: selected.sizeBytes,
            sha256: selected.sha256 ?? undefined,
            createdBy,
            createdFrom: "restore",
            changeSummary: `Restored revision ${selected.ordinal}`,
          });
        }),
    };
  }),
);

export const listArtifacts = (input?: {
  readonly threadId?: string;
  readonly query?: string;
}): Effect.Effect<readonly ArtifactDescriptor[], ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).list(input);
  });

export const getArtifactDetail = (
  id: string,
): Effect.Effect<ArtifactDetail, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).detail(id);
  });

export const createArtifact = (
  input: CreateArtifactInput,
): Effect.Effect<ArtifactDescriptor, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).create(input);
  });

export const registerUploadedArtifact = (
  input: RegisterUploadedArtifactInput,
): Effect.Effect<ArtifactDescriptor, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).registerUploaded(input);
  });

export const createArtifactVersion = (
  input: CreateVersionInput,
): Effect.Effect<ArtifactDescriptor, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).createVersion(input);
  });

export const registerUploadedArtifactVersion = (
  input: RegisterUploadedVersionInput,
): Effect.Effect<ArtifactDescriptor, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).registerUploadedVersion(input);
  });

export const renameArtifact = (
  id: string,
  title: string,
): Effect.Effect<ArtifactDescriptor, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).rename(id, title);
  });

export const deleteArtifact = (
  id: string,
): Effect.Effect<{ readonly deleted: boolean }, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).remove(id);
  });

export const getArtifactVersion = (
  artifactId: string,
  versionId?: string,
): Effect.Effect<ArtifactVersion, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).version(artifactId, versionId);
  });

export const readArtifactText = (
  artifactId: string,
  versionId?: string,
): Effect.Effect<string, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).readText(artifactId, versionId);
  });

export const openArtifactContent = (
  artifactId: string,
  versionId?: string,
): Effect.Effect<
  { readonly version: ArtifactVersion; readonly blob: GetBlobResult },
  ArtifactsError,
  Artifacts
> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).openContent(artifactId, versionId);
  });

export const getArtifactDraft = (
  artifactId: string,
): Effect.Effect<
  { readonly content: string; readonly updatedAt: string } | null,
  ArtifactsError,
  Artifacts
> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).getDraft(artifactId);
  });

export const saveArtifactDraft = (
  artifactId: string,
  content: string,
): Effect.Effect<
  { readonly content: string; readonly updatedAt: string },
  ArtifactsError,
  Artifacts
> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).saveDraft(artifactId, content);
  });

export const deleteArtifactDraft = (
  artifactId: string,
): Effect.Effect<void, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).deleteDraft(artifactId);
  });

export const addArtifactComment = (input: {
  readonly artifactId: string;
  readonly versionId: string;
  readonly body: string;
  readonly selection?: unknown;
  readonly createdBy: string;
}): Effect.Effect<ArtifactComment, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).addComment(input);
  });

export const createArtifactShare = (input: {
  readonly artifactId: string;
  readonly versionId: string;
  readonly expiresInDays: number;
}): Effect.Effect<
  { readonly share: ArtifactShare; readonly token: string },
  ArtifactsError,
  Artifacts
> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).createShare(input);
  });

export const revokeArtifactShare = (
  artifactId: string,
  shareId: string,
): Effect.Effect<{ readonly revoked: boolean }, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).revokeShare(artifactId, shareId);
  });

export const listArtifactShares = (
  artifactId: string,
): Effect.Effect<readonly ArtifactShare[], ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).listShares(artifactId);
  });

export const resolveArtifactShare = (
  token: string,
): Effect.Effect<
  { readonly artifact: ArtifactDescriptor; readonly version: ArtifactVersion },
  ArtifactsError,
  Artifacts
> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).resolveShare(token);
  });

export const restoreArtifactVersion = (
  artifactId: string,
  versionId: string,
  createdBy: string,
): Effect.Effect<ArtifactDescriptor, ArtifactsError, Artifacts> =>
  Effect.gen(function* () {
    return yield* (yield* Artifacts).restore(artifactId, versionId, createdBy);
  });
