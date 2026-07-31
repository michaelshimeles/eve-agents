import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { Context, Data, Effect, Layer, Schema, Semaphore } from "effect";
import type { SchemaError } from "effect/SchemaError";

import { type DatabaseError, Db } from "./db";

// Agentcard (https://agentcard.sh) gives the agent a virtual Visa it can
// spend: prepaid cards with a fixed limit. The capability arrives as an MCP
// server, wired up in agent/connections/agentcard.ts. Connecting is entirely
// backend-to-backend: this deployment exchanges its client credentials for a
// platform bearer, sends the owner a one-time code, verifies it, records the
// owner's consent, and stores the resulting rotating token pair encrypted.
// There is deliberately no browser OAuth or hosted Agentcard sign-in path.
//
// The active credential is app-scoped on purpose: eve's interactive
// authorization strategies are pinned to `principalType: "user"`, and this
// app's eve channel admits anonymous callers (agent/channels/eve.ts uses
// none()), so a user-scoped grant could never resolve — schedules, inbound
// email, and Telegram all run without an end-user principal. One stored
// grant backs every surface, while the encrypted connection row itself is
// keyed per Agentcard user id.

const DEFAULT_MCP_URL = "https://mcp.agentcard.sh/mcp";
const DEFAULT_API_URL = "https://api.agentcard.sh";

/** Where the owner manages cards, funding, and plan outside the agent. */
export const AGENTCARD_DASHBOARD_URL = "https://app.agentcard.sh";

const HTTP_TIMEOUT = "20 seconds";

/** Refresh this far ahead of expiry so a token never dies mid-tool-call. */
export const REFRESH_MARGIN_MS = 120_000;

/** An unfinished authorization is abandoned after this long. */
export const PENDING_TTL_MS = 15 * 60_000;

/** Version of the authorization copy rendered in Manage -> Card. */
export const AGENTCARD_TERMS_VERSION = "ruth-agentcard-2026-07-29-v2";

/** Pointer to the one connection this single-owner deployment currently uses. */
export const ACTIVE_CONNECTION_ROW = "active_connection";
/** Pending connect attempt; the provider's connect_id never reaches the browser. */
export const CONNECT_PENDING_ROW = "connect_pending";
/** Old plaintext row used before Connect API became the only flow. */
const LEGACY_TOKENS_ROW = "tokens";

const TOKEN_ENCRYPTION_VERSION = 1;
const TOKEN_ENCRYPTION_ALGORITHM = "aes-256-gcm";
const TOKEN_KEY_CONTEXT = "eveclaw:agentcard:connection:v1";

/**
 * Why an Agentcard call could not be made. `reason` drives both the sentence
 * the model reads and the status code the API routes return, so each value is
 * a case the owner can actually act on.
 */
export class AgentcardError extends Data.TaggedError("AgentcardError")<{
  readonly reason:
    | "not_connected"
    | "reauthorize"
    | "no_database"
    | "provider"
    | "authorization_state"
    | "not_configured"
    | "consent_required";
  readonly detail?: string;
  /** HTTP status behind a `provider` failure; absent when nothing answered. */
  readonly status?: number;
  /** Stable Agentcard error code from `{ error: { code, message, docs } }`. */
  readonly code?: string;
  readonly docs?: string;
  /** Extra prerequisites carried by `user_info_required`. */
  readonly missingFields?: readonly string[];
  /** Provider-specific branch detail, such as why a phone OTP failed. */
  readonly providerReason?: string;
}> {}

export function describeAgentcardError(error: AgentcardError): string {
  const reconnect =
    "Ask the owner to reconnect under Manage -> Card with a one-time code; never send him to a hosted Agentcard sign-in page.";
  switch (error.reason) {
    case "not_connected":
      return `Agentcard is not connected yet, so there is no card to spend from. ${reconnect} Do not ask him for a card number, and do not try to pay any other way.`;
    case "reauthorize":
      return `The Agentcard connection expired or was revoked. ${reconnect}`;
    case "no_database":
      return "Agentcard needs DATABASE_URL to store its connection, and this deployment has no database configured.";
    case "not_configured":
      return `Agentcard Connect is missing configuration: ${error.detail ?? "a required environment variable is unset"}.`;
    case "authorization_state":
      return `That Agentcard connection could not be completed: ${error.detail ?? "the connect attempt is no longer valid"}. Start the connection again.`;
    case "consent_required":
      return "Agentcard cannot be connected until the owner explicitly authorizes Ruth and accepts the applicable Agentcard and card issuer terms.";
    case "provider":
      return `Agentcard rejected the request${error.code === undefined ? "" : ` (${error.code})`}: ${error.detail ?? "unknown error"}${
        error.missingFields === undefined || error.missingFields.length === 0
          ? ""
          : ` Missing: ${error.missingFields.join(", ")}.`
      }${error.providerReason === undefined ? "" : ` Reason: ${error.providerReason}.`}`;
  }
}

export type AgentcardStoreError = AgentcardError | DatabaseError | SchemaError;

// --- Stored rows -----------------------------------------------------------

/** Decrypted only in server memory and never returned by an app route. */
export const StoredTokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_at: Schema.Finite,
  connected_at: Schema.Finite,
  user_id: Schema.String,
  email: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  phone: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});
export type StoredTokens = typeof StoredTokens.Type;

const EncryptedTokenPair = Schema.Struct({
  version: Schema.Literal(TOKEN_ENCRYPTION_VERSION),
  algorithm: Schema.Literal(TOKEN_ENCRYPTION_ALGORITHM),
  iv: Schema.String,
  ciphertext: Schema.String,
  auth_tag: Schema.String,
});

const StoredConnection = Schema.Struct({
  kind: Schema.Literal("agentcard_connection"),
  user_id: Schema.String,
  email: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
  expires_at: Schema.Finite,
  connected_at: Schema.Finite,
  /** Safe comparison value for cross-instance refresh-race cleanup. */
  access_token_hash: Schema.String,
  tokens: EncryptedTokenPair,
});

const ActiveConnection = Schema.Struct({
  kind: Schema.Literal("agentcard_active_connection"),
  user_id: Schema.String,
});

/** Previous code-flow format, migrated on first read so no plaintext remains. */
const LegacyStoredTokens = Schema.Struct({
  mode: Schema.optionalKey(Schema.String),
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_at: Schema.Finite,
  connected_at: Schema.Finite,
  user_id: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  phone: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export interface AgentcardStatus {
  readonly connected: boolean;
  /** ISO timestamp of the last successful authorization. */
  readonly connectedAt: string | null;
  /** False when the database or backend Agentcard credentials are absent. */
  readonly canConnect: boolean;
  readonly unavailableReason: "database" | "credentials" | null;
}

export interface AgentcardAttachedCard {
  readonly brand: string | null;
  readonly last4: string | null;
}

export type AgentcardAttachmentStartResult =
  | {
      readonly status: "pending";
      readonly attachUrl: string;
      readonly expiresAt: string;
    }
  | {
      readonly status: "active";
      readonly card: AgentcardAttachedCard;
    }
  | {
      readonly status: "ineligible";
      readonly reason: string;
      readonly message: string;
    }
  | {
      readonly status: "user_info_required";
      readonly missingFields: readonly string[];
      readonly message: string;
    }
  | {
      readonly status: "unavailable";
      readonly message: string;
    };

export type AgentcardAttachmentStatusResult =
  | {
      readonly status: "pending";
    }
  | {
      readonly status: "active";
      readonly card: AgentcardAttachedCard;
    }
  | {
      readonly status: "ineligible";
      readonly reason: string;
      readonly message: string;
    }
  | {
      readonly status: "no_attachment";
    }
  | {
      readonly status: "unavailable";
      readonly message: string;
    };

export type AgentcardPhoneStartResult =
  | {
      readonly status: "sent";
      readonly channel: "sms" | "email";
      readonly phone: string;
      readonly expiresInSeconds: number;
    }
  | {
      readonly status: "already_verified";
    };

export interface AgentcardFundingSession {
  readonly checkoutUrl: string;
  readonly expiresAt: string;
  readonly amountCents: number;
  readonly paymentMethod: "apple_pay" | "google_pay";
}

// --- Configuration ---------------------------------------------------------

/**
 * The MCP endpoint. Repointing it (as with `ORGO_API_BASE_URL`) is how the
 * capability is exercised without a real Agentcard account — see
 * `scripts/agentcard-stub.mjs`.
 */
export function agentcardMcpUrl(): string {
  const configured = process.env.AGENTCARD_MCP_URL?.trim();
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_MCP_URL;
}

/** The Connect REST API base; the stub serves this surface too. */
export function agentcardApiUrl(): string {
  const configured = process.env.AGENTCARD_API_URL?.trim();
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_API_URL;
}

/** Both dashboard-issued backend credentials are required for Connect API. */
export function agentcardConfigured(): boolean {
  const id = process.env.AGENTCARD_CLIENT_ID?.trim() ?? "";
  const secret = process.env.AGENTCARD_CLIENT_SECRET?.trim() ?? "";
  return id.length > 0 && secret.length > 0;
}

export type AgentcardConnectTarget = { readonly email: string } | { readonly phone: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Accept exactly one delivery channel and normalize its value. This is shared
 * by routes and tools so malformed input never reaches Agentcard.
 */
export function parseAgentcardConnectTarget(input: unknown): AgentcardConnectTarget | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim() : "";
  const phone = typeof record.phone === "string" ? record.phone.trim() : "";
  if ((email.length > 0) === (phone.length > 0)) return null;
  if (email.length > 0) {
    return email.length <= 320 && EMAIL_PATTERN.test(email) ? { email } : null;
  }
  return E164_PATTERN.test(phone) ? { phone } : null;
}

/**
 * Optional pinned destination for the owner-only chat tool. Browser API
 * callers enter their own email or E.164 phone number instead.
 */
export function agentcardOwnerConnectTarget(): AgentcardConnectTarget | null {
  return parseAgentcardConnectTarget({
    email: process.env.AGENTCARD_OWNER_EMAIL,
    phone: process.env.AGENTCARD_OWNER_PHONE,
  });
}

function hasDatabase(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

function requireClientSecret(): Effect.Effect<string, AgentcardError> {
  const secret = process.env.AGENTCARD_CLIENT_SECRET?.trim() ?? "";
  return secret.length > 0
    ? Effect.succeed(secret)
    : Effect.fail(
        new AgentcardError({
          reason: "not_configured",
          detail: "set AGENTCARD_CLIENT_ID and AGENTCARD_CLIENT_SECRET as backend environment variables",
        }),
      );
}

export function agentcardConnectionRowName(userId: string): string {
  const key = createHash("sha256").update(userId).digest("base64url");
  return `connection:${key}`;
}

function accessTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function tokenEncryptionKey(secret: string, userId: string): Buffer {
  return createHash("sha256")
    .update(TOKEN_KEY_CONTEXT)
    .update("\0")
    .update(userId)
    .update("\0")
    .update(secret)
    .digest();
}

function tokenAad(userId: string): Buffer {
  return Buffer.from(`${TOKEN_KEY_CONTEXT}:${userId}`, "utf8");
}

function encryptStoredTokens(
  value: StoredTokens,
): Effect.Effect<typeof StoredConnection.Type, AgentcardError> {
  return Effect.gen(function* () {
    const secret = yield* requireClientSecret();
    return yield* Effect.try({
      try: () => {
        const iv = randomBytes(12);
        const cipher = createCipheriv(
          TOKEN_ENCRYPTION_ALGORITHM,
          tokenEncryptionKey(secret, value.user_id),
          iv,
        );
        cipher.setAAD(tokenAad(value.user_id));
        const ciphertext = Buffer.concat([
          cipher.update(
            JSON.stringify({
              access_token: value.access_token,
              refresh_token: value.refresh_token,
            }),
            "utf8",
          ),
          cipher.final(),
        ]);
        return {
          kind: "agentcard_connection" as const,
          user_id: value.user_id,
          email: value.email,
          phone: value.phone,
          expires_at: value.expires_at,
          connected_at: value.connected_at,
          access_token_hash: accessTokenHash(value.access_token),
          tokens: {
            version: 1 as const,
            algorithm: "aes-256-gcm" as const,
            iv: iv.toString("base64url"),
            ciphertext: ciphertext.toString("base64url"),
            auth_tag: cipher.getAuthTag().toString("base64url"),
          },
        };
      },
      catch: () =>
        new AgentcardError({
          reason: "reauthorize",
          detail: "the stored Agentcard connection could not be encrypted",
        }),
    });
  });
}

function decryptStoredTokens(
  value: typeof StoredConnection.Type,
): Effect.Effect<StoredTokens, AgentcardError | SchemaError> {
  return Effect.gen(function* () {
    const secret = yield* requireClientSecret();
    const pair = yield* Effect.try({
      try: () => {
        const decipher = createDecipheriv(
          TOKEN_ENCRYPTION_ALGORITHM,
          tokenEncryptionKey(secret, value.user_id),
          Buffer.from(value.tokens.iv, "base64url"),
        );
        decipher.setAAD(tokenAad(value.user_id));
        decipher.setAuthTag(Buffer.from(value.tokens.auth_tag, "base64url"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(value.tokens.ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
        return JSON.parse(plaintext) as unknown;
      },
      catch: () =>
        new AgentcardError({
          reason: "reauthorize",
          detail:
            "the stored Agentcard connection could not be decrypted; reconnect after rotating the client secret",
        }),
    });
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        access_token: Schema.String,
        refresh_token: Schema.String,
      }),
    )(pair);
    return {
      access_token: decoded.access_token,
      refresh_token: decoded.refresh_token,
      expires_at: value.expires_at,
      connected_at: value.connected_at,
      user_id: value.user_id,
      email: value.email,
      phone: value.phone,
    };
  });
}

// --- HTTP ------------------------------------------------------------------

export interface RequestOptions {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly form?: Record<string, string>;
  readonly json?: unknown;
  readonly headers?: Record<string, string>;
  /** Only safe/idempotent exchanges may retry transport and 5xx failures. */
  readonly retry?: boolean;
}

/**
 * One JSON request against an Agentcard endpoint. Connect verify and refresh
 * consume rotating credentials, so callers opt in to retries only for safe
 * exchanges such as client_credentials.
 */
export function requestJson(options: RequestOptions): Effect.Effect<unknown, AgentcardError> {
  const attempt = Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = { accept: "application/json" };
      let body: string | undefined;
      if (options.form !== undefined) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(options.form).toString();
      } else if (options.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.json);
      }
      Object.assign(headers, options.headers);

      const response = await fetch(options.url, {
        method: options.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      });
      const text = await response.text();
      if (!response.ok) {
        const provider = providerFailure(text);
        throw new HttpFailure(
          response.status,
          provider?.message ?? `HTTP ${response.status}`,
          provider?.code,
          provider?.docs,
          provider?.missingFields,
          provider?.reason,
        );
      }
      return text.length === 0 ? null : (JSON.parse(text) as unknown);
    },
    catch: (cause) =>
      cause instanceof HttpFailure
        ? new AgentcardError({
            reason: "provider",
            detail: cause.message,
            status: cause.status,
            ...(cause.code === undefined ? {} : { code: cause.code }),
            ...(cause.docs === undefined ? {} : { docs: cause.docs }),
            ...(cause.missingFields === undefined
              ? {}
              : { missingFields: cause.missingFields }),
            ...(cause.providerReason === undefined
              ? {}
              : { providerReason: cause.providerReason }),
          })
        : new AgentcardError({
            reason: "provider",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
  });

  const requested = options.retry
    ? attempt.pipe(
        Effect.retry({
          times: 2,
          // A refused authorization must surface as-is; only transport and
          // server faults are worth repeating for an idempotent exchange.
          while: (error: AgentcardError) => isRetryable(error),
        }),
      )
    : attempt;

  return requested.pipe(
    Effect.timeoutOrElse({
      duration: HTTP_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new AgentcardError({
            reason: "provider",
            detail: `no response within ${HTTP_TIMEOUT}`,
          }),
        ),
    }),
  );
}

/** Carries the status code out of `fetch` so retry policy can see it. */
class HttpFailure extends Error {
  readonly status: number;
  readonly code?: string;
  readonly docs?: string;
  readonly missingFields?: readonly string[];
  readonly providerReason?: string;

  constructor(
    status: number,
    message: string,
    code?: string,
    docs?: string,
    missingFields?: readonly string[],
    providerReason?: string,
  ) {
    super(message);
    this.name = "HttpFailure";
    this.status = status;
    this.code = code;
    this.docs = docs;
    this.missingFields = missingFields;
    this.providerReason = providerReason;
  }
}

function isRetryable(error: AgentcardError): boolean {
  // No status means nothing answered (DNS, connection reset), which is worth
  // another go. A 4xx is a decision repeating cannot change.
  return error.status === undefined || error.status >= 500;
}

interface ProviderFailure {
  readonly code?: string;
  readonly message: string;
  readonly docs?: string;
  readonly missingFields?: readonly string[];
  readonly reason?: string;
}

/**
 * Connect API errors are `{ error: { code, message, docs } }`. The flat OAuth
 * shape remains a compatibility fallback for token endpoints and the local
 * stub while deployments roll forward.
 */
function providerFailure(body: string): ProviderFailure | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const { error, error_description: description } = parsed as {
        error?: unknown;
        error_description?: unknown;
      };
      if (error !== null && typeof error === "object") {
        const nested = error as Record<string, unknown>;
        const code = typeof nested.code === "string" ? nested.code : undefined;
        const message =
          typeof nested.message === "string"
            ? nested.message
            : code === undefined
              ? "unknown error"
              : code;
        const docs = typeof nested.docs === "string" ? nested.docs : undefined;
        const root = parsed as Record<string, unknown>;
        const missingFieldsValue = nested.missing_fields ?? root.missing_fields;
        const missingFields = Array.isArray(missingFieldsValue)
          ? missingFieldsValue.filter(
              (field): field is string => typeof field === "string",
            )
          : undefined;
        const providerReason =
          typeof nested.reason === "string"
            ? nested.reason
            : typeof root.reason === "string"
              ? root.reason
              : undefined;
        return {
          ...(code === undefined ? {} : { code }),
          message,
          ...(docs === undefined ? {} : { docs }),
          ...(missingFields === undefined ? {} : { missingFields }),
          ...(providerReason === undefined ? {} : { reason: providerReason }),
        };
      }
      const code = typeof error === "string" ? error : undefined;
      const detail = typeof description === "string" ? description : undefined;
      if (code !== undefined || detail !== undefined) {
        return {
          ...(code === undefined ? {} : { code }),
          message: detail ?? code ?? "unknown error",
        };
      }
    }
  } catch {
    // Not JSON.
  }
  const trimmed = body.trim();
  return trimmed.length === 0 ? null : { message: trimmed.slice(0, 300) };
}

/** True when the provider says the grant itself is gone, not merely stale. */
export function isGrantRejection(error: AgentcardError): boolean {
  return (
    error.code === "invalid_grant" ||
    error.code === "invalid_client" ||
    error.code === "unauthorized_client" ||
    error.code === "invalid_refresh_token" ||
    /invalid_grant|invalid_client|unauthorized_client|invalid_refresh_token/.test(
      error.detail ?? "",
    )
  );
}

// --- Storage ---------------------------------------------------------------

/**
 * The agentcard_oauth table as a service: one jsonb value per name, plus the
 * conditional deletes the race handling depends on. Both flows store through
 * this; tests swap in the in-memory layer from agentcard.testing.ts.
 */
export class AgentcardStore extends Context.Service<AgentcardStore, {
  readonly available: () => boolean;
  readonly read: (name: string) => Effect.Effect<unknown | null, DatabaseError | AgentcardError>;
  readonly write: (
    name: string,
    value: unknown,
  ) => Effect.Effect<void, DatabaseError | AgentcardError>;
  /**
   * Replace the encrypted grant and its active pointer as one commit. The old
   * per-user row is removed in the same transaction when the owner changes.
   */
  readonly activateConnection: (input: {
    readonly connectionName: string;
    readonly connection: unknown;
    readonly active: unknown;
    readonly previousConnectionName: string | null;
  }) => Effect.Effect<void, DatabaseError | AgentcardError>;
  readonly remove: (name: string) => Effect.Effect<void, DatabaseError | AgentcardError>;
  /** Delete only while the row's `jsonField` still equals `equals`. */
  readonly removeMatching: (
    name: string,
    jsonField: string,
    equals: string,
  ) => Effect.Effect<void, DatabaseError | AgentcardError>;
  /** Read-and-delete in one statement. */
  readonly take: (
    name: string,
  ) => Effect.Effect<unknown | null, DatabaseError | AgentcardError>;
  /** Read-and-delete only on a field match, atomically. */
  readonly takeMatching: (
    name: string,
    jsonField: string,
    equals: string,
  ) => Effect.Effect<unknown | null, DatabaseError | AgentcardError>;
}>()("AgentcardStore") {}

/**
 * The JSON keys conditional statements may match on. The field name is
 * interpolated into SQL (a bind parameter cannot name a key), so it must
 * come from this allowlist — anything else is a programmer error.
 */
const STORE_FIELDS = new Set([
  "state",
  "access_token",
  "access_token_hash",
  "connect_id",
  "user_id",
]);

export const AgentcardStoreLive = Layer.effect(
  AgentcardStore,
  Effect.gen(function* () {
    const database = yield* Db;

    let tableReady = false;
    const ensureTable = Effect.suspend(() =>
      tableReady
        ? Effect.void
        : database
            .query(
              `CREATE TABLE IF NOT EXISTS agentcard_oauth (
                 name text PRIMARY KEY,
                 value jsonb NOT NULL,
                 updated_at timestamptz NOT NULL DEFAULT now()
               )`,
            )
            .pipe(Effect.tap(() => Effect.sync(() => (tableReady = true))), Effect.asVoid),
    );
    const requireDatabase = Effect.suspend(() =>
      hasDatabase() ? Effect.void : Effect.fail(new AgentcardError({ reason: "no_database" })),
    );
    const ready = requireDatabase.pipe(Effect.andThen(ensureTable));
    const guardField = (field: string): Effect.Effect<void> =>
      STORE_FIELDS.has(field)
        ? Effect.void
        : Effect.die(new Error(`agentcard store: unexpected match field ${field}`));
    const upsert =
      `INSERT INTO agentcard_oauth (name, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;

    return {
      available: () => hasDatabase(),
      read: (name) =>
        Effect.gen(function* () {
          yield* ready;
          const rows = yield* database.query(
            "SELECT value FROM agentcard_oauth WHERE name = $1",
            [name],
          );
          return (rows[0] as { value?: unknown } | undefined)?.value ?? null;
        }),
      write: (name, value) =>
        Effect.gen(function* () {
          yield* ready;
          yield* database.query(upsert, [name, JSON.stringify(value)]);
        }),
      activateConnection: (input) =>
        Effect.gen(function* () {
          yield* ready;
          const statements = [
            {
              sql: upsert,
              params: [input.connectionName, JSON.stringify(input.connection)],
            },
            {
              sql: upsert,
              params: [ACTIVE_CONNECTION_ROW, JSON.stringify(input.active)],
            },
            ...(input.previousConnectionName === null ||
            input.previousConnectionName === input.connectionName
              ? []
              : [
                  {
                    sql: "DELETE FROM agentcard_oauth WHERE name = $1",
                    params: [input.previousConnectionName],
                  },
                ]),
          ];
          yield* database.transaction(statements);
        }),
      remove: (name) =>
        Effect.gen(function* () {
          yield* ready;
          yield* database.query("DELETE FROM agentcard_oauth WHERE name = $1", [name]);
        }),
      removeMatching: (name, jsonField, equals) =>
        Effect.gen(function* () {
          yield* guardField(jsonField);
          yield* ready;
          yield* database.query(
            `DELETE FROM agentcard_oauth WHERE name = $1 AND value->>'${jsonField}' = $2`,
            [name, equals],
          );
        }),
      take: (name) =>
        Effect.gen(function* () {
          yield* ready;
          const rows = yield* database.query(
            "DELETE FROM agentcard_oauth WHERE name = $1 RETURNING value",
            [name],
          );
          return (rows[0] as { value?: unknown } | undefined)?.value ?? null;
        }),
      takeMatching: (name, jsonField, equals) =>
        Effect.gen(function* () {
          yield* guardField(jsonField);
          yield* ready;
          const rows = yield* database.query(
            `DELETE FROM agentcard_oauth WHERE name = $1 AND value->>'${jsonField}' = $2 RETURNING value`,
            [name, equals],
          );
          return (rows[0] as { value?: unknown } | undefined)?.value ?? null;
        }),
    };
  }),
);

// --- Service ---------------------------------------------------------------

export interface AgentcardFlow {
  readonly startConnect: (
    target: AgentcardConnectTarget,
  ) => Effect.Effect<
    { expiresAt: string | null; channel: "email" | "phone" },
    AgentcardStoreError
  >;
  readonly verifyConnect: (params: {
    readonly code: string;
    readonly consent: boolean;
  }) => Effect.Effect<void, AgentcardStoreError>;
  readonly startAttachment: () => Effect.Effect<
    AgentcardAttachmentStartResult,
    AgentcardStoreError
  >;
  readonly attachmentStatus: () => Effect.Effect<
    AgentcardAttachmentStatusResult,
    AgentcardStoreError
  >;
  readonly recordConsent: () => Effect.Effect<void, AgentcardStoreError>;
  readonly startPhoneVerification: (params: {
    readonly phoneNumber?: string;
  }) => Effect.Effect<AgentcardPhoneStartResult, AgentcardStoreError>;
  readonly verifyPhone: (params: {
    readonly code: string;
    readonly phoneNumber?: string;
  }) => Effect.Effect<void, AgentcardStoreError>;
  readonly fundWallet: (params: {
    readonly amountCents: number;
    readonly paymentMethod: "apple_pay" | "google_pay";
  }) => Effect.Effect<AgentcardFundingSession, AgentcardStoreError>;
}

export class Agentcard extends Context.Service<Agentcard, {
  readonly status: () => Effect.Effect<AgentcardStatus, AgentcardStoreError>;
  /** A live bearer for the MCP server, refreshed when it is close to expiry. */
  readonly accessToken: () => Effect.Effect<
    { token: string; expiresAt: number | null },
    AgentcardStoreError
  >;
  /**
   * Rotate the connection grant after the MCP server rejects its bearer.
   * The rejected token makes this conditional, so concurrent MCP clients
   * reuse a winner's new pair instead of rotating it again.
   */
  readonly refreshAfterRejection: (
    rejectedAccessToken: string,
  ) => Effect.Effect<
    { token: string; expiresAt: number | null },
    AgentcardStoreError
  >;
  readonly disconnect: () => Effect.Effect<void, AgentcardStoreError>;
  readonly flow: AgentcardFlow;
}>()("Agentcard") {}

// --- Grant machinery -------------------------------------------------------

/** What `makeGrantMachinery` hands a flow layer to build on. */
export interface GrantMachinery {
  /** The active per-user encrypted grant, decrypted only for this process. */
  readonly currentTokens: () => Effect.Effect<StoredTokens | null, AgentcardStoreError>;
  readonly storeTokens: (tokens: StoredTokens) => Effect.Effect<void, AgentcardStoreError>;
  /**
   * The grant the server refused is gone for good: clear it — unless a
   * concurrent refresh already replaced it, in which case the replacement is
   * the live grant and this failure was just the race's losing side.
   */
  readonly resolveRejectedGrant: (
    rejected: StoredTokens,
  ) => Effect.Effect<StoredTokens, AgentcardStoreError>;
  readonly status: () => Effect.Effect<AgentcardStatus, AgentcardStoreError>;
  readonly disconnect: () => Effect.Effect<void, AgentcardStoreError>;
  /**
   * The shared accessToken body: serve a fresh grant as-is, otherwise
   * refresh behind the gate with the Connect API exchange. A caller that
   * queued behind an in-flight refresh finds the fresh grant already stored
   * and skips its own exchange entirely.
   */
  readonly accessTokenVia: (
    refresh: (tokens: StoredTokens) => Effect.Effect<StoredTokens, AgentcardStoreError>,
  ) => Effect.Effect<{ token: string; expiresAt: number | null }, AgentcardStoreError>;
  /**
   * Force a refresh only while the stored pair is still the bearer the MCP
   * server rejected. This is the 401 path; normal expiry uses accessTokenVia.
   */
  readonly refreshAfterRejectionVia: (
    rejectedAccessToken: string,
    refresh: (tokens: StoredTokens) => Effect.Effect<StoredTokens, AgentcardStoreError>,
  ) => Effect.Effect<{ token: string; expiresAt: number | null }, AgentcardStoreError>;
}

export const makeGrantMachinery = (): Effect.Effect<GrantMachinery, never, AgentcardStore> =>
  Effect.gen(function* () {
    const store = yield* AgentcardStore;
    // One refresh at a time in this process. Refresh tokens rotate on use,
    // so two callers redeeming the same one produces a winner and an
    // invalid-grant loser; serializing lets the second caller reuse the
    // first one's result instead of racing it.
    const refreshGate = yield* Semaphore.make(1);

    const decodeActive = Schema.decodeUnknownEffect(ActiveConnection);
    const decodeConnection = Schema.decodeUnknownEffect(StoredConnection);
    const decodeLegacy = Schema.decodeUnknownEffect(LegacyStoredTokens);

    const storeTokens = (tokens: StoredTokens): Effect.Effect<void, AgentcardStoreError> =>
      Effect.gen(function* () {
        const previousRaw = yield* store.read(ACTIVE_CONNECTION_ROW);
        const previous =
          previousRaw === null
            ? null
            : yield* decodeActive(previousRaw).pipe(
                Effect.catch(() => Effect.succeed(null)),
              );
        const encrypted = yield* encryptStoredTokens(tokens);
        const connectionName = agentcardConnectionRowName(tokens.user_id);
        yield* store.activateConnection({
          connectionName,
          connection: encrypted,
          active: {
            kind: "agentcard_active_connection",
            user_id: tokens.user_id,
          },
          previousConnectionName:
            previous !== null && previous.user_id !== tokens.user_id
              ? agentcardConnectionRowName(previous.user_id)
              : null,
        });
      });

    const migrateLegacy = (): Effect.Effect<StoredTokens | null, AgentcardStoreError> =>
      Effect.gen(function* () {
        const stored = yield* store.read(LEGACY_TOKENS_ROW);
        if (stored === null) return null;
        const legacy = yield* decodeLegacy(stored).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (
          legacy === null ||
          legacy.mode !== "company" ||
          legacy.user_id === null
        ) {
          // Browser-OAuth grants have no Connect user id and cannot satisfy
          // the new per-user storage contract. Remove the plaintext row.
          yield* store.remove(LEGACY_TOKENS_ROW);
          return null;
        }
        const tokens: StoredTokens = {
          access_token: legacy.access_token,
          refresh_token: legacy.refresh_token,
          expires_at: legacy.expires_at,
          connected_at: legacy.connected_at,
          user_id: legacy.user_id,
          email: legacy.email,
          phone: legacy.phone ?? null,
        };
        yield* storeTokens(tokens);
        yield* store.remove(LEGACY_TOKENS_ROW);
        return tokens;
      });

    const currentTokens = (): Effect.Effect<StoredTokens | null, AgentcardStoreError> =>
      Effect.gen(function* () {
        const stored = yield* store.read(ACTIVE_CONNECTION_ROW);
        if (stored === null) return yield* migrateLegacy();
        const active = yield* decodeActive(stored).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (active === null) {
          yield* store.remove(ACTIVE_CONNECTION_ROW);
          return yield* migrateLegacy();
        }
        const raw = yield* store.read(agentcardConnectionRowName(active.user_id));
        if (raw === null) {
          yield* store.removeMatching(ACTIVE_CONNECTION_ROW, "user_id", active.user_id);
          return null;
        }
        const connection = yield* decodeConnection(raw);
        if (connection.user_id !== active.user_id) {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "reauthorize",
              detail: "the stored Agentcard connection does not match its user",
            }),
          );
        }
        return yield* decryptStoredTokens(connection);
      });

    /** Usable as-is, with enough margin left that a tool call won't outlive it. */
    const isFresh = (tokens: StoredTokens): boolean =>
      tokens.expires_at - REFRESH_MARGIN_MS > Date.now();

    const resolveRejectedGrant = (
      rejected: StoredTokens,
    ): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        const removed = yield* store.takeMatching(
          agentcardConnectionRowName(rejected.user_id),
          "access_token_hash",
          accessTokenHash(rejected.access_token),
        );
        if (removed !== null) {
          yield* store.removeMatching(ACTIVE_CONNECTION_ROW, "user_id", rejected.user_id);
        }
        const current = yield* currentTokens();
        if (current !== null && current.access_token !== rejected.access_token) {
          return current;
        }
        return yield* Effect.fail(new AgentcardError({ reason: "reauthorize" }));
      });

    const status = (): Effect.Effect<AgentcardStatus, AgentcardStoreError> =>
      Effect.gen(function* () {
        if (!store.available()) {
          return {
            connected: false,
            connectedAt: null,
            canConnect: false,
            unavailableReason: "database",
          };
        }
        if (!agentcardConfigured()) {
          return {
            connected: false,
            connectedAt: null,
            canConnect: false,
            unavailableReason: "credentials",
          };
        }
        const tokens = yield* currentTokens().pipe(
          Effect.catchTag("AgentcardError", (error) =>
            error.reason === "reauthorize"
              ? Effect.succeed(null)
              : Effect.fail(error),
          ),
        );
        return {
          connected: tokens !== null,
          connectedAt: tokens === null ? null : new Date(tokens.connected_at).toISOString(),
          canConnect: true,
          unavailableReason: null,
        };
      });

    // Disconnect -> Connect is a full reset without reaching into Neon.
    const disconnect = (): Effect.Effect<void, AgentcardStoreError> =>
      Effect.gen(function* () {
        const stored = yield* store.take(ACTIVE_CONNECTION_ROW);
        const active =
          stored === null
            ? null
            : yield* decodeActive(stored).pipe(Effect.catch(() => Effect.succeed(null)));
        if (active !== null) yield* store.remove(agentcardConnectionRowName(active.user_id));
        yield* store.remove(CONNECT_PENDING_ROW);
        yield* store.remove(LEGACY_TOKENS_ROW);
      });

    const accessTokenVia = (
      refresh: (tokens: StoredTokens) => Effect.Effect<StoredTokens, AgentcardStoreError>,
    ): Effect.Effect<{ token: string; expiresAt: number | null }, AgentcardStoreError> =>
      Effect.gen(function* () {
        const tokens = yield* currentTokens();
        if (tokens === null) {
          return yield* Effect.fail(new AgentcardError({ reason: "not_connected" }));
        }
        if (isFresh(tokens)) {
          return { token: tokens.access_token, expiresAt: tokens.expires_at };
        }

        // Stale: refresh behind the gate, and re-read once inside it.
        return yield* refreshGate.withPermits(1)(
          Effect.gen(function* () {
            const latest = yield* currentTokens();
            if (latest === null) {
              return yield* Effect.fail(new AgentcardError({ reason: "not_connected" }));
            }
            if (isFresh(latest)) {
              return { token: latest.access_token, expiresAt: latest.expires_at };
            }
            const refreshed = yield* refresh(latest);
            return { token: refreshed.access_token, expiresAt: refreshed.expires_at };
          }),
        );
      });

    const refreshAfterRejectionVia = (
      rejectedAccessToken: string,
      refresh: (tokens: StoredTokens) => Effect.Effect<StoredTokens, AgentcardStoreError>,
    ): Effect.Effect<{ token: string; expiresAt: number | null }, AgentcardStoreError> =>
      refreshGate.withPermits(1)(
        Effect.gen(function* () {
          const latest = yield* currentTokens();
          if (latest === null) {
            return yield* Effect.fail(new AgentcardError({ reason: "not_connected" }));
          }

          // Another request or process already replaced the rejected pair.
          // Reuse that winner instead of invalidating it with a second
          // rotating-refresh exchange.
          if (latest.access_token !== rejectedAccessToken) {
            return { token: latest.access_token, expiresAt: latest.expires_at };
          }

          const refreshed = yield* refresh(latest);
          return { token: refreshed.access_token, expiresAt: refreshed.expires_at };
        }),
      );

    return {
      currentTokens,
      storeTokens,
      resolveRejectedGrant,
      status,
      disconnect,
      accessTokenVia,
      refreshAfterRejectionVia,
    };
  });

// --- Accessors -------------------------------------------------------------

// Build programs against the service without resolving it, so call sites
// stay one-liners and tests can swap the layer.

export const agentcardStatus = (): Effect.Effect<
  AgentcardStatus,
  AgentcardStoreError,
  Agentcard
> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).status();
  });

export const agentcardAccessToken = (): Effect.Effect<
  { token: string; expiresAt: number | null },
  AgentcardStoreError,
  Agentcard
> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).accessToken();
  });

export const refreshAgentcardAfterMcpUnauthorized = (
  rejectedAccessToken: string,
): Effect.Effect<
  { token: string; expiresAt: number | null },
  AgentcardStoreError,
  Agentcard
> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).refreshAfterRejection(rejectedAccessToken);
  });

export const disconnectAgentcard = (): Effect.Effect<void, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).disconnect();
  });

export const startAgentcardConnect = (
  target: AgentcardConnectTarget,
): Effect.Effect<
  { expiresAt: string | null; channel: "email" | "phone" },
  AgentcardStoreError,
  Agentcard
> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).flow.startConnect(target);
  });

export const verifyAgentcardConnect = (params: {
  readonly code: string;
  readonly consent: boolean;
}): Effect.Effect<void, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).flow.verifyConnect(params);
  });

export const startAgentcardAttachment = (): Effect.Effect<
  AgentcardAttachmentStartResult,
  AgentcardStoreError,
  Agentcard
> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).flow.startAttachment();
  });

export const agentcardAttachmentStatus = (): Effect.Effect<
  AgentcardAttachmentStatusResult,
  AgentcardStoreError,
  Agentcard
> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).flow.attachmentStatus();
  });

export const recordAgentcardConsent = (): Effect.Effect<
  void,
  AgentcardStoreError,
  Agentcard
> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).flow.recordConsent();
  });

export const startAgentcardPhoneVerification = (params: {
  readonly phoneNumber?: string;
}): Effect.Effect<AgentcardPhoneStartResult, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).flow.startPhoneVerification(params);
  });

export const verifyAgentcardPhone = (params: {
  readonly code: string;
  readonly phoneNumber?: string;
}): Effect.Effect<void, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).flow.verifyPhone(params);
  });

export const fundAgentcardWallet = (params: {
  readonly amountCents: number;
  readonly paymentMethod: "apple_pay" | "google_pay";
}): Effect.Effect<AgentcardFundingSession, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).flow.fundWallet(params);
  });
