import { get, head } from "@vercel/blob";
import type { GetBlobResult } from "@vercel/blob";
import { Context, Data, Effect, Layer, Schema } from "effect";
import type { SchemaError } from "effect/SchemaError";

import {
  chatFilePath,
  MAX_CHAT_FILE_BYTES,
  type UploadedChatFile,
} from "@/lib/files-api";
import { type DatabaseError, Db } from "./db";

export const ChatFile = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.NullOr(Schema.String),
  filename: Schema.String,
  mediaType: Schema.String,
  sizeBytes: Schema.Int,
  createdAt: Schema.String,
});
export type ChatFile = typeof ChatFile.Type;

export class ChatFileError extends Data.TaggedError("ChatFileError")<{
  readonly code:
    "not_configured" | "not_found" | "invalid_file" | "storage_failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function describeChatFileError(error: ChatFileError): string {
  return error.message;
}

export type ChatFilesError = ChatFileError | DatabaseError | SchemaError;

function databaseConfigured(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

function storageConfigured(): boolean {
  return (
    (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim().length > 0 ||
    ((process.env.VERCEL_OIDC_TOKEN ?? "").trim().length > 0 &&
      (process.env.BLOB_STORE_ID ?? "").trim().length > 0)
  );
}

function storageTry<A>(
  operation: () => Promise<A>,
  message: string,
): Effect.Effect<A, ChatFileError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new ChatFileError({ code: "storage_failed", message, cause }),
  });
}

function validateUpload(
  input: UploadedChatFile,
): Effect.Effect<void, ChatFileError> {
  if (
    input.id.length === 0 ||
    input.threadId.length === 0 ||
    input.filename.length === 0 ||
    input.mediaType.length === 0 ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 0 ||
    input.sizeBytes > MAX_CHAT_FILE_BYTES ||
    input.blobPath !== chatFilePath(input.id, input.filename)
  ) {
    return Effect.fail(
      new ChatFileError({
        code: "invalid_file",
        message: "The uploaded file metadata is invalid.",
      }),
    );
  }
  return Effect.void;
}

export class ChatFiles extends Context.Service<
  ChatFiles,
  {
    readonly list: (
      ownerId: string,
    ) => Effect.Effect<readonly ChatFile[], ChatFilesError>;
    readonly register: (
      ownerId: string,
      input: UploadedChatFile,
    ) => Effect.Effect<ChatFile, ChatFilesError>;
    readonly open: (
      ownerId: string,
      id: string,
    ) => Effect.Effect<
      { readonly file: ChatFile; readonly blob: GetBlobResult },
      ChatFilesError
    >;
  }
>()("ChatFiles") {}

export const ChatFilesLive = Layer.effect(
  ChatFiles,
  Effect.gen(function* () {
    const database = yield* Db;
    let ensured = false;
    const decodeFiles = Schema.decodeUnknownEffect(Schema.Array(ChatFile));

    const ensure = Effect.gen(function* () {
      if (!databaseConfigured()) {
        return yield* Effect.fail(
          new ChatFileError({
            code: "not_configured",
            message: "Files need DATABASE_URL and a private Vercel Blob store.",
          }),
        );
      }
      if (ensured) return;
      // Files can be the first persisted surface opened in a fresh database.
      // Establish the thread relation before using it for optional labels; the
      // thread store adds its remaining metadata columns when it starts.
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS web_chat_threads (
          id text PRIMARY KEY,
          title text NOT NULL,
          updated_at bigint NOT NULL,
          chat jsonb NOT NULL DEFAULT '{}'::jsonb
        )
      `);
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS chat_files (
          id text PRIMARY KEY,
          thread_id text NOT NULL,
          filename text NOT NULL,
          media_type text NOT NULL,
          size_bytes bigint NOT NULL,
          blob_url text NOT NULL,
          blob_path text NOT NULL,
          owner_id text NOT NULL DEFAULT 'web:owner',
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      yield* database.query(
        "ALTER TABLE chat_files ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'web:owner'",
      );
      yield* database.query(
        "CREATE INDEX IF NOT EXISTS chat_files_owner_created_idx ON chat_files (owner_id, created_at DESC)",
      );
      yield* database.query(
        "CREATE INDEX IF NOT EXISTS chat_files_owner_thread_idx ON chat_files (owner_id, thread_id, created_at DESC)",
      );
      ensured = true;
    });

    const projection = `
      f.id,
      f.thread_id AS "threadId",
      t.title AS "threadTitle",
      f.filename,
      f.media_type AS "mediaType",
      f.size_bytes::int AS "sizeBytes",
      f.created_at::text AS "createdAt"
    `;

    const find = (ownerId: string, id: string) =>
      Effect.gen(function* () {
        yield* ensure;
        const rows = yield* database.query(
          `SELECT ${projection}
             FROM chat_files f
             LEFT JOIN web_chat_threads t ON t.id = f.thread_id
            WHERE f.owner_id = $1
              AND f.id = $2`,
          [ownerId, id],
        );
        const file = (yield* decodeFiles(rows))[0];
        if (file === undefined) {
          return yield* Effect.fail(
            new ChatFileError({
              code: "not_found",
              message: "File not found.",
            }),
          );
        }
        return file;
      });

    return {
      list: (ownerId) =>
        Effect.gen(function* () {
          yield* ensure;
          const rows = yield* database.query(
            `SELECT ${projection}
               FROM chat_files f
               LEFT JOIN web_chat_threads t ON t.id = f.thread_id
              WHERE f.owner_id = $1
              ORDER BY f.created_at DESC`,
            [ownerId],
          );
          return yield* decodeFiles(rows);
        }),

      register: (ownerId, input) =>
        Effect.gen(function* () {
          yield* ensure;
          yield* validateUpload(input);
          if (!storageConfigured()) {
            return yield* Effect.fail(
              new ChatFileError({
                code: "not_configured",
                message:
                  "Files need DATABASE_URL and a private Vercel Blob store.",
              }),
            );
          }
          const metadata = yield* storageTry(
            () => head(input.blobUrl),
            "Could not verify the uploaded file in private Blob storage.",
          );
          if (
            metadata.pathname !== input.blobPath ||
            metadata.size !== input.sizeBytes ||
            metadata.url !== input.blobUrl ||
            !metadata.url.includes(".private.blob.vercel-storage.com/")
          ) {
            return yield* Effect.fail(
              new ChatFileError({
                code: "invalid_file",
                message: "The uploaded Blob metadata does not match this file.",
              }),
            );
          }
          const rows = yield* database.query(
            `INSERT INTO chat_files (
               id, thread_id, filename, media_type, size_bytes, blob_url, blob_path, owner_id
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE
               SET thread_id = EXCLUDED.thread_id,
                   filename = EXCLUDED.filename,
                   media_type = EXCLUDED.media_type,
                   size_bytes = EXCLUDED.size_bytes
             WHERE chat_files.blob_path = EXCLUDED.blob_path
               AND chat_files.owner_id = EXCLUDED.owner_id
             RETURNING id`,
            [
              input.id,
              input.threadId,
              input.filename,
              input.mediaType,
              input.sizeBytes,
              input.blobUrl,
              input.blobPath,
              ownerId,
            ],
          );
          if (rows.length === 0) {
            return yield* Effect.fail(
              new ChatFileError({
                code: "invalid_file",
                message: "A different upload already uses this file id.",
              }),
            );
          }
          return yield* find(ownerId, input.id);
        }),

      open: (ownerId, id) =>
        Effect.gen(function* () {
          const file = yield* find(ownerId, id);
          const rows = yield* database.query(
            `SELECT blob_url AS "blobUrl"
               FROM chat_files
              WHERE owner_id = $1
                AND id = $2`,
            [ownerId, id],
          );
          const blobUrl = rows[0]?.blobUrl;
          if (typeof blobUrl !== "string") {
            return yield* Effect.fail(
              new ChatFileError({
                code: "not_found",
                message: "File content not found.",
              }),
            );
          }
          const blob = yield* storageTry(
            () => get(blobUrl, { access: "private" }),
            "Could not read the file from private Blob storage.",
          );
          if (blob === null || blob.statusCode !== 200) {
            return yield* Effect.fail(
              new ChatFileError({
                code: "not_found",
                message: "File content not found.",
              }),
            );
          }
          return { file, blob };
        }),
    };
  }),
);

export const listChatFiles = (
  ownerId: string,
): Effect.Effect<
  readonly ChatFile[],
  ChatFilesError,
  ChatFiles
> =>
  Effect.gen(function* () {
    return yield* (yield* ChatFiles).list(ownerId);
  });

export const registerChatFile = (
  ownerId: string,
  input: UploadedChatFile,
): Effect.Effect<ChatFile, ChatFilesError, ChatFiles> =>
  Effect.gen(function* () {
    return yield* (yield* ChatFiles).register(ownerId, input);
  });

export const openChatFile = (
  ownerId: string,
  id: string,
): Effect.Effect<
  { readonly file: ChatFile; readonly blob: GetBlobResult },
  ChatFilesError,
  ChatFiles
> =>
  Effect.gen(function* () {
    return yield* (yield* ChatFiles).open(ownerId, id);
  });
