import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { Context, Data, Effect, Layer, Schema } from "effect";
import type { SchemaError } from "effect/SchemaError";

import { type DatabaseError, Db } from "../db";
import type { IMessageCommand, IMessageCommandResult } from "./schema";

const MESSAGE_REF_PREFIX = "imr_";
const COMMAND_RESULT_LIMIT = 32_000;
const INTERACTION_STATE_LIMIT = 64_000;

export class IMessageStoreError extends Data.TaggedError("IMessageStoreError")<{
  readonly reason: "configuration" | "conflict" | "not_found" | "validation";
  readonly detail: string;
}> {}

export type RichStoreError = IMessageStoreError | DatabaseError | SchemaError;

function encryptionKey(material = process.env.IMESSAGE_DATA_ENCRYPTION_KEY): Buffer {
  const value = material?.trim() ?? "";
  if (value.length === 0) {
    throw new IMessageStoreError({
      reason: "configuration",
      detail: "IMESSAGE_DATA_ENCRYPTION_KEY is required for provider message references",
    });
  }
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 32) return decoded;
  throw new IMessageStoreError({
    reason: "configuration",
    detail: "IMESSAGE_DATA_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hex characters",
  });
}

export function encryptProviderIdentifier(value: string, material?: string): string {
  const key = encryptionKey(material);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptProviderIdentifier(value: string, material?: string): string {
  const [version, iv, tag, encrypted] = value.split(":");
  if (version !== "v1" || iv === undefined || tag === undefined || encrypted === undefined) {
    throw new IMessageStoreError({
      reason: "validation",
      detail: "provider identifier ciphertext is malformed",
    });
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(material),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new IMessageStoreError({
      reason: "validation",
      detail: "provider identifier ciphertext could not be decrypted",
    });
  }
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerHash(
  phone: string,
  conversationKey: string,
  providerMessageId: string,
): string {
  return stableHash(`${phone}\0${conversationKey}\0${providerMessageId}`);
}

function commandHash(command: IMessageCommand): string {
  return stableHash(JSON.stringify(command));
}

function safeResultJson(result: IMessageCommandResult): string {
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json, "utf8") > COMMAND_RESULT_LIMIT) {
    throw new IMessageStoreError({
      reason: "validation",
      detail: "command result exceeds the persistence limit",
    });
  }
  return json;
}

const MessageRefRow = Schema.Struct({
  message_ref: Schema.String,
  provider_message_encrypted: Schema.String,
});

const CommandRow = Schema.Struct({
  command_hash: Schema.String,
  status: Schema.String,
  result: Schema.Unknown,
});

const IngressRow = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  provider_event_id: Schema.String,
  phone: Schema.String,
  conversation_key: Schema.String,
  provider_sequence: Schema.NullOr(Schema.Finite),
  raw_body: Schema.String,
  attempts: Schema.Int,
});

const CursorRow = Schema.Struct({
  last_contiguous_sequence: Schema.Finite,
  lease_holder: Schema.NullOr(Schema.String),
  lease_expires_at: Schema.NullOr(Schema.String),
  last_catchup_result: Schema.NullOr(Schema.String),
});

const InteractionRow = Schema.Struct({
  interaction_id: Schema.String,
  conversation_key: Schema.String,
  eve_request_id: Schema.String,
  kind: Schema.String,
  state_version: Schema.Int,
  status: Schema.String,
  sensitive: Schema.Boolean,
  state: Schema.Unknown,
  result: Schema.Unknown,
  expires_at: Schema.String,
});

export interface IngressClaim {
  readonly id: string;
  readonly source: string;
  readonly providerEventId: string;
  readonly phone: string;
  readonly conversationKey: string;
  readonly providerSequence: number | null;
  readonly rawBody: string;
  readonly attempts: number;
}

export interface IngressStats {
  readonly queued: number;
  readonly processing: number;
  readonly retry: number;
  readonly dead: number;
}

export interface ProviderHealth {
  readonly phone: string;
  readonly eventStream: string;
  readonly lastContiguousSequence: number;
  readonly leaseActive: boolean;
  readonly lastCatchupResult: string | null;
  readonly updatedAt: string;
}

export interface DeadLetterView {
  readonly id: string;
  readonly source: string;
  readonly conversationRef: string;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly receivedAt: string;
}

export interface EnqueueIngressInput {
  readonly source: "webhook" | "advanced";
  readonly providerEventId: string;
  readonly phone: string;
  readonly conversationKey: string;
  readonly providerSequence?: number;
  readonly rawBody: string;
}

export interface FailIngressInput {
  readonly id: string;
  readonly workerId: string;
  readonly errorCode: string;
  readonly retryAt: Date | null;
}

export interface RegisterMessageRefInput {
  readonly providerMessageId: string;
  readonly phone: string;
  readonly conversationKey: string;
  readonly direction: "inbound" | "outbound";
  readonly contentType: string;
  /** Provider mutation state such as a Mini App card session. Encrypted. */
  readonly providerState?: unknown;
}

export interface ResolveMessageRefInput {
  readonly messageRef: string;
  readonly phone: string;
  readonly conversationKey: string;
}

export interface ProviderCursor {
  readonly lastContiguousSequence: number;
  readonly leaseHolder: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastCatchupResult: string | null;
}

export type CommandClaim =
  | { readonly status: "new" }
  | { readonly status: "pending" }
  | { readonly status: "completed"; readonly result: IMessageCommandResult };

export interface InteractionView {
  readonly interactionId: string;
  readonly conversationKey: string;
  readonly eveRequestId: string;
  readonly kind: string;
  readonly stateVersion: number;
  readonly status: string;
  readonly sensitive: boolean;
  readonly state: unknown;
  readonly result: unknown;
  readonly expiresAt: string;
}

export class IMessageRichStore extends Context.Service<IMessageRichStore, {
  readonly enqueueIngress: (
    input: EnqueueIngressInput,
  ) => Effect.Effect<{ readonly id: string; readonly inserted: boolean }, RichStoreError>;
  readonly claimIngress: (
    input: {
      readonly conversationKey: string;
      readonly workerId: string;
    },
  ) => Effect.Effect<IngressClaim | null, RichStoreError>;
  readonly acquireWorkerLease: (input: {
    readonly conversationKey: string;
    readonly workerId: string;
  }) => Effect.Effect<boolean, RichStoreError>;
  readonly releaseWorkerLease: (input: {
    readonly conversationKey: string;
    readonly workerId: string;
  }) => Effect.Effect<void, RichStoreError>;
  readonly completeIngress: (input: {
    readonly id: string;
    readonly workerId: string;
  }) => Effect.Effect<void, RichStoreError>;
  readonly failIngress: (input: FailIngressInput) => Effect.Effect<void, RichStoreError>;
  readonly ingressStats: () => Effect.Effect<IngressStats, RichStoreError>;
  readonly providerHealth: () => Effect.Effect<readonly ProviderHealth[], RichStoreError>;
  readonly deadLetters: () => Effect.Effect<readonly DeadLetterView[], RichStoreError>;
  readonly replayDeadLetter: (
    id: string,
  ) => Effect.Effect<{ readonly conversationKey: string } | null, RichStoreError>;
  readonly registerMessageRef: (
    input: RegisterMessageRefInput,
  ) => Effect.Effect<string, RichStoreError>;
  readonly resolveMessageRef: (
    input: ResolveMessageRefInput,
  ) => Effect.Effect<string, RichStoreError>;
  readonly inspectMessageRef: (
    messageRef: string,
  ) => Effect.Effect<{
    readonly providerMessageId: string;
    readonly phone: string;
    readonly conversationKey: string;
  }, RichStoreError>;
  readonly resolveMessageRefState: (
    input: ResolveMessageRefInput,
  ) => Effect.Effect<unknown | null, RichStoreError>;
  readonly claimCommand: (command: IMessageCommand) => Effect.Effect<CommandClaim, RichStoreError>;
  readonly completeCommand: (
    command: IMessageCommand,
    result: IMessageCommandResult,
  ) => Effect.Effect<void, RichStoreError>;
  readonly releaseCommand: (
    command: IMessageCommand,
  ) => Effect.Effect<void, RichStoreError>;
  readonly acquireProviderLease: (input: {
    readonly phone: string;
    readonly eventStream: string;
    readonly workerId: string;
    readonly leaseSeconds: number;
  }) => Effect.Effect<ProviderCursor | null, RichStoreError>;
  readonly renewProviderLease: (input: {
    readonly phone: string;
    readonly eventStream: string;
    readonly workerId: string;
    readonly leaseSeconds: number;
  }) => Effect.Effect<boolean, RichStoreError>;
  readonly advanceProviderCursor: (input: {
    readonly phone: string;
    readonly eventStream: string;
    readonly workerId: string;
    readonly sequence: number;
    readonly catchupResult?: string;
  }) => Effect.Effect<boolean, RichStoreError>;
  readonly releaseProviderLease: (input: {
    readonly phone: string;
    readonly eventStream: string;
    readonly workerId: string;
  }) => Effect.Effect<void, RichStoreError>;
  readonly createInteraction: (input: {
    readonly commandId?: string;
    readonly conversationKey: string;
    readonly eveRequestId: string;
    readonly kind: string;
    readonly sensitive: boolean;
    readonly state: unknown;
    readonly ttlSeconds?: number;
  }) => Effect.Effect<{
    readonly interactionId: string;
    readonly token: string;
    readonly stateVersion: number;
    readonly expiresAt: string;
  }, RichStoreError>;
  readonly readInteraction: (input: {
    readonly interactionId: string;
    readonly token: string;
  }) => Effect.Effect<InteractionView | null, RichStoreError>;
  readonly readInteractionForAuthorization: (
    interactionId: string,
  ) => Effect.Effect<InteractionView | null, RichStoreError>;
  readonly consumeInteraction: (input: {
    readonly interactionId: string;
    readonly token: string;
    readonly stateVersion: number;
    readonly result: unknown;
    readonly ownerAuthenticated: boolean;
  }) => Effect.Effect<
    { readonly status: "accepted"; readonly interaction: InteractionView } |
      { readonly status: "rejected"; readonly reason: string },
    RichStoreError
  >;
  readonly claimInteractionResume: (input: {
    readonly interactionId: string;
    readonly workerId: string;
  }) => Effect.Effect<InteractionView | null, RichStoreError>;
  readonly completeInteractionResume: (input: {
    readonly interactionId: string;
    readonly workerId: string;
  }) => Effect.Effect<boolean, RichStoreError>;
  readonly releaseInteractionResume: (input: {
    readonly interactionId: string;
    readonly workerId: string;
    readonly errorCode: string;
  }) => Effect.Effect<void, RichStoreError>;
  readonly audit: (input: {
    readonly actionCategory: string;
    readonly actorRole: "owner" | "guest" | "system";
    readonly targetType: "dm" | "space" | "line";
    readonly decision: "allowed" | "denied" | "failed";
  }) => Effect.Effect<void, RichStoreError>;
  readonly cleanupRetention: () => Effect.Effect<void, RichStoreError>;
}>()("IMessageRichStore") {}

export const IMessageRichStoreLive = Layer.effect(
  IMessageRichStore,
  Effect.gen(function* () {
    const database = yield* Db;
    let ready = false;
    const ensureTables = Effect.suspend(() =>
      ready
        ? Effect.void
        : Effect.gen(function* () {
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_ingress_event (
                 id uuid PRIMARY KEY,
                 source text NOT NULL,
                 provider_event_id text NOT NULL,
                 phone text NOT NULL,
                 conversation_key text NOT NULL,
                 provider_sequence bigint,
                 raw_body text,
                 status text NOT NULL DEFAULT 'queued',
                 attempts integer NOT NULL DEFAULT 0,
                 next_attempt_at timestamptz NOT NULL DEFAULT now(),
                 error_code text,
                 received_at timestamptz NOT NULL DEFAULT now(),
                 processed_at timestamptz,
                 body_expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
                 UNIQUE (source, provider_event_id)
               )`,
            );
            yield* database.query(
              `CREATE INDEX IF NOT EXISTS imessage_ingress_partition_idx
                 ON imessage_ingress_event
                 (conversation_key, status, next_attempt_at, provider_sequence, received_at)`,
            );
            yield* database.query(
              `ALTER TABLE imessage_ingress_event
                 ADD COLUMN IF NOT EXISTS claim_holder text`,
            );
            yield* database.query(
              `ALTER TABLE imessage_ingress_event
                 ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_conversation_worker (
                 conversation_key text PRIMARY KEY,
                 lease_holder text NOT NULL,
                 lease_expires_at timestamptz NOT NULL,
                 updated_at timestamptz NOT NULL DEFAULT now()
               )`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_provider_cursor (
                 phone text NOT NULL,
                 event_stream text NOT NULL,
                 last_contiguous_sequence bigint NOT NULL DEFAULT 0,
                 lease_holder text,
                 lease_expires_at timestamptz,
                 last_catchup_result text,
                 updated_at timestamptz NOT NULL DEFAULT now(),
                 PRIMARY KEY (phone, event_stream)
               )`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_message_ref (
                 message_ref text PRIMARY KEY,
                 provider_hash text NOT NULL UNIQUE,
                 provider_message_encrypted text NOT NULL,
                 phone text NOT NULL,
                 conversation_key text NOT NULL,
                 direction text NOT NULL,
                 content_type text NOT NULL,
                 created_at timestamptz NOT NULL DEFAULT now(),
                 expires_at timestamptz
               )`,
            );
            yield* database.query(
              `CREATE INDEX IF NOT EXISTS imessage_message_ref_binding_idx
                 ON imessage_message_ref (phone, conversation_key, message_ref)`,
            );
            yield* database.query(
              `ALTER TABLE imessage_message_ref
                 ADD COLUMN IF NOT EXISTS provider_state_encrypted text`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_command (
                 command_id text PRIMARY KEY,
                 command_hash text NOT NULL,
                 phone text NOT NULL,
                 conversation_key text NOT NULL,
                 operation text NOT NULL,
                 status text NOT NULL DEFAULT 'pending',
                 result jsonb,
                 attempts integer NOT NULL DEFAULT 1,
                 lease_expires_at timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
                 created_at timestamptz NOT NULL DEFAULT now(),
                 completed_at timestamptz
               )`,
            );
            yield* database.query(
              `ALTER TABLE imessage_command
                 ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1`,
            );
            yield* database.query(
              `ALTER TABLE imessage_command
                 ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz
                 NOT NULL DEFAULT now() + interval '60 seconds'`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_interaction (
                 interaction_id uuid PRIMARY KEY,
                 token_hash text NOT NULL,
                 conversation_key text NOT NULL,
                 eve_request_id text NOT NULL,
                 state_version integer NOT NULL DEFAULT 1,
                 status text NOT NULL,
                 kind text NOT NULL DEFAULT 'generic',
                 sensitive boolean NOT NULL DEFAULT false,
                 state jsonb NOT NULL DEFAULT '{}'::jsonb,
                 result jsonb,
                 expires_at timestamptz NOT NULL,
                 audit_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
                 created_at timestamptz NOT NULL DEFAULT now()
               )`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction
                 ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'generic'`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction
                 ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction
                 ADD COLUMN IF NOT EXISTS state jsonb NOT NULL DEFAULT '{}'::jsonb`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction ADD COLUMN IF NOT EXISTS result jsonb`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction ADD COLUMN IF NOT EXISTS used_at timestamptz`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction
                 ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction
                 ADD COLUMN IF NOT EXISTS command_id text`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction
                 ADD COLUMN IF NOT EXISTS token_encrypted text`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction
                 ADD COLUMN IF NOT EXISTS resume_attempts integer NOT NULL DEFAULT 0`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction
                 ADD COLUMN IF NOT EXISTS resume_lease_holder text`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction
                 ADD COLUMN IF NOT EXISTS resume_lease_expires_at timestamptz`,
            );
            yield* database.query(
              `ALTER TABLE imessage_interaction
                 ADD COLUMN IF NOT EXISTS last_resume_error text`,
            );
            yield* database.query(
              `CREATE UNIQUE INDEX IF NOT EXISTS imessage_interaction_command_idx
                 ON imessage_interaction (command_id)
                 WHERE command_id IS NOT NULL`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_media_temp (
                 media_id uuid PRIMARY KEY,
                 blob_id text NOT NULL,
                 mime_type text NOT NULL,
                 byte_size bigint NOT NULL,
                 processing_state text NOT NULL,
                 expires_at timestamptz NOT NULL,
                 created_at timestamptz NOT NULL DEFAULT now()
               )`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_line_state (
                 phone text PRIMARY KEY,
                 allocation_state text NOT NULL DEFAULT 'active',
                 line_capacity integer,
                 daily_message_count integer NOT NULL DEFAULT 0,
                 daily_new_conversation_count integer NOT NULL DEFAULT 0,
                 event_health text NOT NULL DEFAULT 'unknown',
                 feature_eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
                 updated_at timestamptz NOT NULL DEFAULT now()
               )`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_conversation_policy (
                 conversation_key text PRIMARY KEY,
                 owner_ref text NOT NULL,
                 members jsonb NOT NULL DEFAULT '[]'::jsonb,
                 guest_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
                 public_memory_namespace text NOT NULL,
                 feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
                 retention_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
                 updated_at timestamptz NOT NULL DEFAULT now()
               )`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_security_audit (
                 id bigserial PRIMARY KEY,
                 action_category text NOT NULL,
                 actor_role text NOT NULL,
                 target_type text NOT NULL,
                 decision text NOT NULL,
                 created_at timestamptz NOT NULL DEFAULT now()
               )`,
            );
            ready = true;
          }),
    );

    const decodeIngress = Schema.decodeUnknownEffect(Schema.Array(IngressRow));
    const decodeRefs = Schema.decodeUnknownEffect(Schema.Array(MessageRefRow));
    const decodeCommands = Schema.decodeUnknownEffect(Schema.Array(CommandRow));
    const decodeCursors = Schema.decodeUnknownEffect(Schema.Array(CursorRow));
    const decodeInteractions = Schema.decodeUnknownEffect(Schema.Array(InteractionRow));

    return {
      enqueueIngress: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const id = randomUUID();
          const rows = yield* database.query(
            `INSERT INTO imessage_ingress_event
               (id, source, provider_event_id, phone, conversation_key, provider_sequence, raw_body)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (source, provider_event_id) DO UPDATE
               SET provider_sequence =
                     coalesce(imessage_ingress_event.provider_sequence,
                              EXCLUDED.provider_sequence)
             RETURNING id::text AS id,
                       (xmax = 0) AS inserted`,
            [
              id,
              input.source,
              input.providerEventId,
              input.phone,
              input.conversationKey,
              input.providerSequence ?? null,
              input.rawBody,
            ],
          );
          const row = rows[0] as
            | { id?: unknown; inserted?: unknown }
            | undefined;
          return {
            id: typeof row?.id === "string" ? row.id : id,
            inserted: row?.inserted === true,
          };
        }),

      claimIngress: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `WITH next AS (
               SELECT id
                 FROM imessage_ingress_event
                WHERE conversation_key = $1
                  AND status IN ('queued', 'retry', 'processing')
                ORDER BY provider_sequence ASC NULLS LAST, received_at ASC, id ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
             )
             UPDATE imessage_ingress_event event
                SET status = CASE
                      WHEN event.next_attempt_at <= now() THEN 'processing'
                      ELSE event.status
                    END,
                    attempts = CASE
                      WHEN event.next_attempt_at <= now() THEN event.attempts + 1
                      ELSE event.attempts
                    END,
                    claim_holder = CASE
                      WHEN event.next_attempt_at <= now() THEN $2
                      ELSE event.claim_holder
                    END,
                    claim_expires_at = CASE
                      WHEN event.next_attempt_at <= now()
                        THEN now() + interval '330 seconds'
                      ELSE event.claim_expires_at
                    END
               FROM next
              WHERE event.id = next.id
                AND (
                  (
                    event.status IN ('queued', 'retry')
                    AND event.next_attempt_at <= now()
                  )
                  OR (
                    event.status = 'processing'
                    AND event.claim_expires_at <= now()
                  )
                )
             RETURNING event.id::text AS id, event.source, event.provider_event_id,
                       event.phone, event.conversation_key,
                       event.provider_sequence::float8 AS provider_sequence,
                       coalesce(event.raw_body, '') AS raw_body, event.attempts`,
            [input.conversationKey, input.workerId],
          );
          const decoded = yield* decodeIngress(rows);
          const row = decoded[0];
          if (row === undefined) return null;
          return {
            id: row.id,
            source: row.source,
            providerEventId: row.provider_event_id,
            phone: row.phone,
            conversationKey: row.conversation_key,
            providerSequence: row.provider_sequence,
            rawBody: row.raw_body,
            attempts: row.attempts,
          };
        }),

      acquireWorkerLease: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `INSERT INTO imessage_conversation_worker
               (conversation_key, lease_holder, lease_expires_at)
             VALUES ($1, $2, now() + interval '360 seconds')
             ON CONFLICT (conversation_key) DO UPDATE
               SET lease_holder = EXCLUDED.lease_holder,
                   lease_expires_at = EXCLUDED.lease_expires_at,
                   updated_at = now()
             WHERE imessage_conversation_worker.lease_expires_at <= now()
                OR imessage_conversation_worker.lease_holder = EXCLUDED.lease_holder
             RETURNING conversation_key`,
            [input.conversationKey, input.workerId],
          );
          return rows.length > 0;
        }),

      releaseWorkerLease: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          yield* database.query(
            `DELETE FROM imessage_conversation_worker
              WHERE conversation_key = $1 AND lease_holder = $2`,
            [input.conversationKey, input.workerId],
          );
        }),

      completeIngress: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `UPDATE imessage_ingress_event
                SET status = 'processed', processed_at = now(), raw_body = NULL,
                    error_code = NULL, claim_holder = NULL, claim_expires_at = NULL
              WHERE id = $1 AND status = 'processing' AND claim_holder = $2
              RETURNING id`,
            [input.id, input.workerId],
          );
          if (rows.length === 0) {
            return yield* Effect.fail(
              new IMessageStoreError({
                reason: "conflict",
                detail: "ingress claim was lost before completion",
              }),
            );
          }
        }),

      failIngress: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          yield* database.query(
            `UPDATE imessage_ingress_event
                SET status = CASE WHEN $3::timestamptz IS NULL THEN 'dead' ELSE 'retry' END,
                    error_code = $2,
                    next_attempt_at = coalesce($3::timestamptz, next_attempt_at),
                    claim_holder = NULL,
                    claim_expires_at = NULL,
                    body_expires_at = CASE
                      WHEN $3::timestamptz IS NULL THEN now() + interval '7 days'
                      ELSE body_expires_at
                    END
              WHERE id = $1 AND status = 'processing' AND claim_holder = $4`,
            [
              input.id,
              input.errorCode.slice(0, 120),
              input.retryAt?.toISOString() ?? null,
              input.workerId,
            ],
          );
        }),

      ingressStats: () =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `SELECT
               count(*) FILTER (WHERE status = 'queued')::int AS queued,
               count(*) FILTER (WHERE status = 'processing')::int AS processing,
               count(*) FILTER (WHERE status = 'retry')::int AS retry,
               count(*) FILTER (WHERE status = 'dead')::int AS dead
             FROM imessage_ingress_event`,
          );
          const row = rows[0] as Partial<Record<keyof IngressStats, unknown>> | undefined;
          return {
            queued: Number(row?.queued ?? 0),
            processing: Number(row?.processing ?? 0),
            retry: Number(row?.retry ?? 0),
            dead: Number(row?.dead ?? 0),
          };
        }),

      providerHealth: () =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `SELECT phone, event_stream,
                    last_contiguous_sequence::float8 AS last_contiguous_sequence,
                    (lease_expires_at > now()) AS lease_active,
                    last_catchup_result, updated_at::text AS updated_at
               FROM imessage_provider_cursor
              ORDER BY phone, event_stream`,
          );
          return rows.map((row) => {
            const value = row as Record<string, unknown>;
            return {
              phone: String(value.phone ?? ""),
              eventStream: String(value.event_stream ?? ""),
              lastContiguousSequence: Number(value.last_contiguous_sequence ?? 0),
              leaseActive: value.lease_active === true,
              lastCatchupResult:
                typeof value.last_catchup_result === "string"
                  ? value.last_catchup_result
                  : null,
              updatedAt: String(value.updated_at ?? ""),
            };
          });
        }),

      deadLetters: () =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `SELECT id::text AS id, source, conversation_key, attempts,
                    error_code, received_at::text AS received_at
               FROM imessage_ingress_event
              WHERE status = 'dead'
              ORDER BY received_at DESC
              LIMIT 50`,
          );
          return rows.map((row) => {
            const value = row as Record<string, unknown>;
            return {
              id: String(value.id ?? ""),
              source: String(value.source ?? ""),
              conversationRef: stableHash(String(value.conversation_key ?? "")).slice(0, 12),
              attempts: Number(value.attempts ?? 0),
              errorCode:
                typeof value.error_code === "string" ? value.error_code : null,
              receivedAt: String(value.received_at ?? ""),
            };
          });
        }),

      replayDeadLetter: (id) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `UPDATE imessage_ingress_event
                SET status = 'queued', attempts = 0, next_attempt_at = now(),
                    error_code = NULL, claim_holder = NULL, claim_expires_at = NULL,
                    body_expires_at = now() + interval '24 hours'
              WHERE id = $1 AND status = 'dead' AND raw_body IS NOT NULL
              RETURNING conversation_key`,
            [id],
          );
          const conversationKey = (rows[0] as { conversation_key?: unknown } | undefined)
            ?.conversation_key;
          return typeof conversationKey === "string" ? { conversationKey } : null;
        }),

      registerMessageRef: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const hash = providerHash(
            input.phone,
            input.conversationKey,
            input.providerMessageId,
          );
          const messageRef = `${MESSAGE_REF_PREFIX}${randomUUID()}`;
          const encrypted = yield* Effect.try({
            try: () => encryptProviderIdentifier(input.providerMessageId),
            catch: (cause) =>
              cause instanceof IMessageStoreError
                ? cause
                : new IMessageStoreError({
                    reason: "configuration",
                    detail: cause instanceof Error ? cause.message : String(cause),
                  }),
          });
          const encryptedState = yield* Effect.try({
            try: () =>
              input.providerState === undefined
                ? null
                : encryptProviderIdentifier(JSON.stringify(input.providerState)),
            catch: (cause) =>
              cause instanceof IMessageStoreError
                ? cause
                : new IMessageStoreError({
                    reason: "validation",
                    detail:
                      cause instanceof Error ? cause.message : String(cause),
                  }),
          });
          const rows = yield* database.query(
            `INSERT INTO imessage_message_ref
               (message_ref, provider_hash, provider_message_encrypted, phone,
                conversation_key, direction, content_type, provider_state_encrypted)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (provider_hash) DO UPDATE
               SET provider_hash = EXCLUDED.provider_hash,
                   provider_state_encrypted = coalesce(
                     EXCLUDED.provider_state_encrypted,
                     imessage_message_ref.provider_state_encrypted
                   )
             RETURNING message_ref, provider_message_encrypted`,
            [
              messageRef,
              hash,
              encrypted,
              input.phone,
              input.conversationKey,
              input.direction,
              input.contentType,
              encryptedState,
            ],
          );
          const decoded = yield* decodeRefs(rows);
          const row = decoded[0];
          if (row === undefined) {
            return yield* Effect.fail(
              new IMessageStoreError({
                reason: "not_found",
                detail: "message reference was not persisted",
              }),
            );
          }
          return row.message_ref;
        }),

      resolveMessageRef: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `SELECT message_ref, provider_message_encrypted
               FROM imessage_message_ref
              WHERE message_ref = $1 AND phone = $2 AND conversation_key = $3
                AND (expires_at IS NULL OR expires_at > now())`,
            [input.messageRef, input.phone, input.conversationKey],
          );
          const decoded = yield* decodeRefs(rows);
          const row = decoded[0];
          if (row === undefined) {
            return yield* Effect.fail(
              new IMessageStoreError({
                reason: "not_found",
                detail: "message reference does not belong to this conversation",
              }),
            );
          }
          return yield* Effect.try({
            try: () => decryptProviderIdentifier(row.provider_message_encrypted),
            catch: (cause) =>
              cause instanceof IMessageStoreError
                ? cause
                : new IMessageStoreError({
                    reason: "validation",
                    detail: cause instanceof Error ? cause.message : String(cause),
                  }),
          });
        }),

      inspectMessageRef: (messageRef) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `SELECT provider_message_encrypted, phone, conversation_key
               FROM imessage_message_ref
              WHERE message_ref = $1
                AND (expires_at IS NULL OR expires_at > now())`,
            [messageRef],
          );
          const row = rows[0];
          if (row === undefined || typeof row.provider_message_encrypted !== "string") {
            return yield* Effect.fail(
              new IMessageStoreError({
                reason: "not_found",
                detail: "opaque attachment reference was not found",
              }),
            );
          }
          return {
            providerMessageId: decryptProviderIdentifier(row.provider_message_encrypted),
            phone: String(row.phone ?? ""),
            conversationKey: String(row.conversation_key ?? ""),
          };
        }),

      resolveMessageRefState: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `SELECT provider_state_encrypted
               FROM imessage_message_ref
              WHERE message_ref = $1 AND phone = $2 AND conversation_key = $3
                AND (expires_at IS NULL OR expires_at > now())`,
            [input.messageRef, input.phone, input.conversationKey],
          );
          const encrypted = rows[0]?.provider_state_encrypted;
          if (encrypted === null || encrypted === undefined) return null;
          if (typeof encrypted !== "string") {
            return yield* Effect.fail(
              new IMessageStoreError({
                reason: "validation",
                detail: "provider state is malformed",
              }),
            );
          }
          return yield* Effect.try({
            try: () => JSON.parse(decryptProviderIdentifier(encrypted)) as unknown,
            catch: (cause) =>
              new IMessageStoreError({
                reason: "validation",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
          });
        }),

      claimCommand: (command) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const hash = commandHash(command);
          const conversationKey =
            command.target.kind === "dm"
              ? `dm:${command.phone}:${command.target.handle}`
              : `space:${command.phone}:${command.target.spaceId}`;
          const inserted = yield* database.query(
            `INSERT INTO imessage_command
               (command_id, command_hash, phone, conversation_key, operation)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (command_id) DO UPDATE
               SET attempts = imessage_command.attempts + 1,
                   lease_expires_at = now() + interval '60 seconds'
             WHERE imessage_command.command_hash = EXCLUDED.command_hash
               AND imessage_command.status = 'pending'
               AND imessage_command.lease_expires_at <= now()
             RETURNING command_id`,
            [command.commandId, hash, command.phone, conversationKey, command.operation],
          );
          if (inserted.length > 0) return { status: "new" as const };
          const rows = yield* database.query(
            `SELECT command_hash, status, result
               FROM imessage_command WHERE command_id = $1`,
            [command.commandId],
          );
          const decoded = yield* decodeCommands(rows);
          const row = decoded[0];
          if (row === undefined || row.command_hash !== hash) {
            return yield* Effect.fail(
              new IMessageStoreError({
                reason: "conflict",
                detail: "commandId was already used for different command data",
              }),
            );
          }
          if (row.status !== "completed") return { status: "pending" as const };
          return {
            status: "completed" as const,
            result: row.result as IMessageCommandResult,
          };
        }),

      completeCommand: (command, result) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const json = yield* Effect.try({
            try: () => safeResultJson(result),
            catch: (cause) =>
              cause instanceof IMessageStoreError
                ? cause
                : new IMessageStoreError({
                    reason: "validation",
                    detail: cause instanceof Error ? cause.message : String(cause),
                  }),
          });
          const rows = yield* database.query(
            `UPDATE imessage_command
                SET status = 'completed', result = $3::jsonb, completed_at = now(),
                    lease_expires_at = now()
              WHERE command_id = $1 AND command_hash = $2
              RETURNING command_id`,
            [command.commandId, commandHash(command), json],
          );
          if (rows.length === 0) {
            return yield* Effect.fail(
              new IMessageStoreError({
                reason: "conflict",
                detail: "command changed before completion",
              }),
            );
          }
        }),

      releaseCommand: (command) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `UPDATE imessage_command
                SET lease_expires_at = now()
              WHERE command_id = $1 AND command_hash = $2 AND status = 'pending'
              RETURNING command_id`,
            [command.commandId, commandHash(command)],
          );
          if (rows.length === 0) {
            return yield* Effect.fail(
              new IMessageStoreError({
                reason: "conflict",
                detail: "command changed before its retry lease was released",
              }),
            );
          }
        }),

      acquireProviderLease: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `INSERT INTO imessage_provider_cursor
               (phone, event_stream, lease_holder, lease_expires_at)
             VALUES ($1, $2, $3, now() + ($4::int * interval '1 second'))
             ON CONFLICT (phone, event_stream) DO UPDATE
               SET lease_holder = EXCLUDED.lease_holder,
                   lease_expires_at = EXCLUDED.lease_expires_at,
                   updated_at = now()
             WHERE imessage_provider_cursor.lease_expires_at IS NULL
                OR imessage_provider_cursor.lease_expires_at <= now()
                OR imessage_provider_cursor.lease_holder = EXCLUDED.lease_holder
             RETURNING last_contiguous_sequence::float8 AS last_contiguous_sequence,
                       lease_holder,
                       lease_expires_at::text AS lease_expires_at,
                       last_catchup_result`,
            [input.phone, input.eventStream, input.workerId, input.leaseSeconds],
          );
          const decoded = yield* decodeCursors(rows);
          const row = decoded[0];
          return row === undefined
            ? null
            : {
                lastContiguousSequence: row.last_contiguous_sequence,
                leaseHolder: row.lease_holder,
                leaseExpiresAt: row.lease_expires_at,
                lastCatchupResult: row.last_catchup_result,
              };
        }),

      renewProviderLease: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `UPDATE imessage_provider_cursor
                SET lease_expires_at = now() + ($4::int * interval '1 second'),
                    updated_at = now()
              WHERE phone = $1 AND event_stream = $2 AND lease_holder = $3
              RETURNING phone`,
            [input.phone, input.eventStream, input.workerId, input.leaseSeconds],
          );
          return rows.length > 0;
        }),

      advanceProviderCursor: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `UPDATE imessage_provider_cursor
                SET last_contiguous_sequence = GREATEST(last_contiguous_sequence, $4),
                    last_catchup_result = coalesce($5, last_catchup_result),
                    updated_at = now()
              WHERE phone = $1 AND event_stream = $2 AND lease_holder = $3
                AND $4 >= last_contiguous_sequence
              RETURNING phone`,
            [
              input.phone,
              input.eventStream,
              input.workerId,
              input.sequence,
              input.catchupResult ?? null,
            ],
          );
          return rows.length > 0;
        }),

      releaseProviderLease: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          yield* database.query(
            `UPDATE imessage_provider_cursor
                SET lease_holder = NULL, lease_expires_at = NULL, updated_at = now()
              WHERE phone = $1 AND event_stream = $2 AND lease_holder = $3`,
            [input.phone, input.eventStream, input.workerId],
          );
        }),

      createInteraction: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const interactionId = randomUUID();
          const token = randomBytes(32).toString("base64url");
          const tokenHash = stableHash(token);
          const encryptedToken = yield* Effect.try({
            try: () => encryptProviderIdentifier(token),
            catch: (cause) =>
              cause instanceof IMessageStoreError
                ? cause
                : new IMessageStoreError({
                    reason: "configuration",
                    detail: cause instanceof Error ? cause.message : String(cause),
                  }),
          });
          const ttlSeconds =
            input.ttlSeconds ??
            (input.sensitive ? 10 * 60 : 24 * 60 * 60);
          const stateJson = yield* Effect.try({
            try: () => JSON.stringify(input.state),
            catch: () =>
              new IMessageStoreError({
                reason: "validation",
                detail: "interaction state is not serializable",
              }),
          });
          if (Buffer.byteLength(stateJson, "utf8") > INTERACTION_STATE_LIMIT) {
            return yield* Effect.fail(
              new IMessageStoreError({
                reason: "validation",
                detail: "interaction state exceeds the persistence limit",
              }),
            );
          }
          const rows = yield* database.query(
            `INSERT INTO imessage_interaction
               (interaction_id, command_id, token_hash, token_encrypted,
                conversation_key, eve_request_id, kind, sensitive, state,
                state_version, status, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 1, 'pending',
                     now() + ($10::int * interval '1 second'))
             ON CONFLICT (command_id) WHERE command_id IS NOT NULL DO UPDATE
               SET command_id = EXCLUDED.command_id
             RETURNING interaction_id::text AS interaction_id,
                       token_encrypted,
                       state_version,
                       expires_at::text AS expires_at`,
            [
              interactionId,
              input.commandId ?? null,
              tokenHash,
              encryptedToken,
              input.conversationKey,
              input.eveRequestId,
              input.kind,
              input.sensitive,
              stateJson,
              ttlSeconds,
            ],
          );
          const row = rows[0] as
            | {
                interaction_id?: unknown;
                token_encrypted?: unknown;
                state_version?: unknown;
                expires_at?: unknown;
              }
            | undefined;
          const persistedToken =
            typeof row?.token_encrypted === "string"
              ? decryptProviderIdentifier(row.token_encrypted)
              : token;
          return {
            interactionId: String(row?.interaction_id ?? interactionId),
            token: persistedToken,
            stateVersion: Number(row?.state_version ?? 1),
            expiresAt: String(row?.expires_at ?? ""),
          };
        }),

      readInteraction: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `SELECT interaction_id::text AS interaction_id, conversation_key,
                    eve_request_id, kind, state_version, status, sensitive,
                    state, result, expires_at::text AS expires_at
               FROM imessage_interaction
              WHERE interaction_id = $1 AND token_hash = $2
                AND expires_at > now()`,
            [input.interactionId, stableHash(input.token)],
          );
          const decoded = yield* decodeInteractions(rows);
          const row = decoded[0];
          return row === undefined
            ? null
            : {
                interactionId: row.interaction_id,
                conversationKey: row.conversation_key,
                eveRequestId: row.eve_request_id,
                kind: row.kind,
                stateVersion: row.state_version,
                status: row.status,
                sensitive: row.sensitive,
                state: row.state,
                result: row.result,
                expiresAt: row.expires_at,
              };
        }),

      readInteractionForAuthorization: (interactionId) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `SELECT interaction_id::text AS interaction_id, conversation_key,
                    eve_request_id, kind, state_version, status, sensitive,
                    state, result, expires_at::text AS expires_at
               FROM imessage_interaction
              WHERE interaction_id = $1 AND expires_at > now()`,
            [interactionId],
          );
          const decoded = yield* decodeInteractions(rows);
          const row = decoded[0];
          return row === undefined
            ? null
            : {
                interactionId: row.interaction_id,
                conversationKey: row.conversation_key,
                eveRequestId: row.eve_request_id,
                kind: row.kind,
                stateVersion: row.state_version,
                status: row.status,
                sensitive: row.sensitive,
                state: row.state,
                result: row.result,
                expiresAt: row.expires_at,
              };
        }),

      consumeInteraction: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const resultJson = yield* Effect.try({
            try: () => JSON.stringify(input.result),
            catch: () =>
              new IMessageStoreError({
                reason: "validation",
                detail: "interaction result is not serializable",
              }),
          });
          if (Buffer.byteLength(resultJson, "utf8") > INTERACTION_STATE_LIMIT) {
            return { status: "rejected" as const, reason: "result is too large" };
          }
          const rows = yield* database.query(
            `UPDATE imessage_interaction
                SET status = 'selected', result = $5::jsonb, used_at = now(),
                    updated_at = now()
              WHERE interaction_id = $1 AND token_hash = $2
                AND state_version = $3 AND status = 'pending'
                AND expires_at > now()
                AND (sensitive = false OR $4 = true)
              RETURNING interaction_id::text AS interaction_id, conversation_key,
                        eve_request_id, kind, state_version, status, sensitive,
                        state, result, expires_at::text AS expires_at`,
            [
              input.interactionId,
              stableHash(input.token),
              input.stateVersion,
              input.ownerAuthenticated,
              resultJson,
            ],
          );
          const decoded = yield* decodeInteractions(rows);
          const row = decoded[0];
          if (row === undefined) {
            // A route can persist the selection and then lose its response
            // while starting Workflow. Repeating the exact same action is
            // idempotent and re-wakes the durable resume outbox.
            const selectedRows = yield* database.query(
              `SELECT interaction_id::text AS interaction_id, conversation_key,
                      eve_request_id, kind, state_version, status, sensitive,
                      state, result, expires_at::text AS expires_at
                 FROM imessage_interaction
                WHERE interaction_id = $1 AND token_hash = $2
                  AND state_version = $3 AND status = 'selected'
                  AND expires_at > now()
                  AND result = $5::jsonb
                  AND (sensitive = false OR $4 = true)`,
              [
                input.interactionId,
                stableHash(input.token),
                input.stateVersion,
                input.ownerAuthenticated,
                resultJson,
              ],
            );
            const selectedDecoded = yield* decodeInteractions(selectedRows);
            const selected = selectedDecoded[0];
            if (selected !== undefined) {
              return {
                status: "accepted" as const,
                interaction: {
                  interactionId: selected.interaction_id,
                  conversationKey: selected.conversation_key,
                  eveRequestId: selected.eve_request_id,
                  kind: selected.kind,
                  stateVersion: selected.state_version,
                  status: selected.status,
                  sensitive: selected.sensitive,
                  state: selected.state,
                  result: selected.result,
                  expiresAt: selected.expires_at,
                },
              };
            }
            const current = yield* database.query(
              `SELECT status, state_version, sensitive, expires_at > now() AS live
                 FROM imessage_interaction
                WHERE interaction_id = $1 AND token_hash = $2`,
              [input.interactionId, stableHash(input.token)],
            );
            const value = current[0] as
              | {
                  status?: unknown;
                  state_version?: unknown;
                  sensitive?: unknown;
                  live?: unknown;
                }
              | undefined;
            const reason =
              value === undefined
                ? "interaction not found"
                : value.live !== true
                  ? "interaction expired"
                  : value.status !== "pending"
                    ? "interaction was already selected"
                    : Number(value.state_version) !== input.stateVersion
                      ? "stale interaction version"
                      : value.sensitive === true && !input.ownerAuthenticated
                        ? "authenticated owner identity is required"
                        : "interaction was rejected";
            return { status: "rejected" as const, reason };
          }
          return {
            status: "accepted" as const,
            interaction: {
              interactionId: row.interaction_id,
              conversationKey: row.conversation_key,
              eveRequestId: row.eve_request_id,
              kind: row.kind,
              stateVersion: row.state_version,
              status: row.status,
              sensitive: row.sensitive,
              state: row.state,
              result: row.result,
              expiresAt: row.expires_at,
            },
          };
        }),

      claimInteractionResume: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `UPDATE imessage_interaction
                SET resume_lease_holder = $2,
                    resume_lease_expires_at = now() + interval '45 seconds',
                    resume_attempts = resume_attempts + 1,
                    updated_at = now()
              WHERE interaction_id = $1
                AND status = 'selected'
                AND expires_at > now()
                AND (
                  resume_lease_expires_at IS NULL
                  OR resume_lease_expires_at <= now()
                  OR resume_lease_holder = $2
                )
              RETURNING interaction_id::text AS interaction_id, conversation_key,
                        eve_request_id, kind, state_version, status, sensitive,
                        state, result, expires_at::text AS expires_at`,
            [input.interactionId, input.workerId],
          );
          const decoded = yield* decodeInteractions(rows);
          const row = decoded[0];
          return row === undefined
            ? null
            : {
                interactionId: row.interaction_id,
                conversationKey: row.conversation_key,
                eveRequestId: row.eve_request_id,
                kind: row.kind,
                stateVersion: row.state_version,
                status: row.status,
                sensitive: row.sensitive,
                state: row.state,
                result: row.result,
                expiresAt: row.expires_at,
              };
        }),

      completeInteractionResume: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          const rows = yield* database.query(
            `UPDATE imessage_interaction
                SET status = 'completed',
                    resume_lease_holder = NULL,
                    resume_lease_expires_at = NULL,
                    last_resume_error = NULL,
                    updated_at = now()
              WHERE interaction_id = $1
                AND status = 'selected'
                AND resume_lease_holder = $2
              RETURNING interaction_id`,
            [input.interactionId, input.workerId],
          );
          return rows.length > 0;
        }),

      releaseInteractionResume: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          yield* database.query(
            `UPDATE imessage_interaction
                SET resume_lease_holder = NULL,
                    resume_lease_expires_at = NULL,
                    last_resume_error = $3,
                    updated_at = now()
              WHERE interaction_id = $1
                AND status = 'selected'
                AND resume_lease_holder = $2`,
            [input.interactionId, input.workerId, input.errorCode.slice(0, 120)],
          );
        }),

      audit: (input) =>
        Effect.gen(function* () {
          yield* ensureTables;
          yield* database.query(
            `INSERT INTO imessage_security_audit
               (action_category, actor_role, target_type, decision)
             VALUES ($1, $2, $3, $4)`,
            [
              input.actionCategory,
              input.actorRole,
              input.targetType,
              input.decision,
            ],
          );
        }),

      cleanupRetention: () =>
        Effect.gen(function* () {
          yield* ensureTables;
          yield* database.query(
            `UPDATE imessage_ingress_event
                SET raw_body = NULL
              WHERE raw_body IS NOT NULL AND body_expires_at <= now()`,
          );
          yield* database.query(
            `DELETE FROM imessage_ingress_event
              WHERE status = 'processed' AND processed_at < now() - interval '24 hours'`,
          );
          yield* database.query(
            `DELETE FROM imessage_ingress_event
              WHERE status = 'dead' AND received_at < now() - interval '7 days'`,
          );
          yield* database.query(
            `DELETE FROM imessage_media_temp WHERE expires_at <= now()`,
          );
          yield* database.query(
            `DELETE FROM imessage_interaction WHERE expires_at < now() - interval '7 days'`,
          );
          yield* database.query(
            `DELETE FROM imessage_message_ref
              WHERE expires_at IS NOT NULL AND expires_at <= now()`,
          );
        }),
    };
  }),
);

export const enqueueIMessageIngress = (
  input: EnqueueIngressInput,
) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).enqueueIngress(input);
  });

export const claimIMessageIngress = (input: {
  readonly conversationKey: string;
  readonly workerId: string;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).claimIngress(input);
  });

export const acquireIMessageWorkerLease = (input: {
  readonly conversationKey: string;
  readonly workerId: string;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).acquireWorkerLease(input);
  });

export const releaseIMessageWorkerLease = (input: {
  readonly conversationKey: string;
  readonly workerId: string;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).releaseWorkerLease(input);
  });

export const completeIMessageIngress = (input: {
  readonly id: string;
  readonly workerId: string;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).completeIngress(input);
  });

export const failIMessageIngress = (
  input: FailIngressInput,
) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).failIngress(input);
  });

export const iMessageIngressStats = () =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).ingressStats();
  });

export const iMessageProviderHealth = () =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).providerHealth();
  });

export const iMessageDeadLetters = () =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).deadLetters();
  });

export const replayIMessageDeadLetter = (id: string) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).replayDeadLetter(id);
  });

export const registerIMessageRef = (
  input: RegisterMessageRefInput,
) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).registerMessageRef(input);
  });

export const resolveIMessageRef = (
  input: ResolveMessageRefInput,
) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).resolveMessageRef(input);
  });

export const inspectIMessageRef = (messageRef: string) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).inspectMessageRef(messageRef);
  });

export const resolveIMessageRefState = (input: ResolveMessageRefInput) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).resolveMessageRefState(input);
  });

export const claimIMessageCommand = (command: IMessageCommand) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).claimCommand(command);
  });

export const completeIMessageCommand = (
  command: IMessageCommand,
  result: IMessageCommandResult,
) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).completeCommand(command, result);
  });

export const releaseIMessageCommand = (command: IMessageCommand) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).releaseCommand(command);
  });

export const acquireIMessageProviderLease = (input: {
  readonly phone: string;
  readonly eventStream: string;
  readonly workerId: string;
  readonly leaseSeconds: number;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).acquireProviderLease(input);
  });

export const renewIMessageProviderLease = (input: {
  readonly phone: string;
  readonly eventStream: string;
  readonly workerId: string;
  readonly leaseSeconds: number;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).renewProviderLease(input);
  });

export const advanceIMessageProviderCursor = (input: {
  readonly phone: string;
  readonly eventStream: string;
  readonly workerId: string;
  readonly sequence: number;
  readonly catchupResult?: string;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).advanceProviderCursor(input);
  });

export const releaseIMessageProviderLease = (input: {
  readonly phone: string;
  readonly eventStream: string;
  readonly workerId: string;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).releaseProviderLease(input);
  });

export const createIMessageInteraction = (input: {
  readonly commandId?: string;
  readonly conversationKey: string;
  readonly eveRequestId: string;
  readonly kind: string;
  readonly sensitive: boolean;
  readonly state: unknown;
  readonly ttlSeconds?: number;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).createInteraction(input);
  });

export const readIMessageInteraction = (input: {
  readonly interactionId: string;
  readonly token: string;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).readInteraction(input);
  });

export const readIMessageInteractionForAuthorization = (
  interactionId: string,
) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore)
      .readInteractionForAuthorization(interactionId);
  });

export const consumeIMessageInteraction = (input: {
  readonly interactionId: string;
  readonly token: string;
  readonly stateVersion: number;
  readonly result: unknown;
  readonly ownerAuthenticated: boolean;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).consumeInteraction(input);
  });

export const claimIMessageInteractionResume = (input: {
  readonly interactionId: string;
  readonly workerId: string;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).claimInteractionResume(input);
  });

export const completeIMessageInteractionResume = (input: {
  readonly interactionId: string;
  readonly workerId: string;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).completeInteractionResume(input);
  });

export const releaseIMessageInteractionResume = (input: {
  readonly interactionId: string;
  readonly workerId: string;
  readonly errorCode: string;
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).releaseInteractionResume(input);
  });

export const auditIMessageSecurity = (input: {
  readonly actionCategory: string;
  readonly actorRole: "owner" | "guest" | "system";
  readonly targetType: "dm" | "space" | "line";
  readonly decision: "allowed" | "denied" | "failed";
}) =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).audit(input);
  });

export const cleanupIMessageRetention = () =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRichStore).cleanupRetention();
  });
