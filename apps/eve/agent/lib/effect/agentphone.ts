import { Context, Data, Effect, Layer, Schema } from "effect";
import type { SchemaError } from "effect/SchemaError";

import { settingsStore } from "../settings-db";
import { type DatabaseError, Db } from "./db";

// Ruth's phone, over AgentPhone (https://agentphone.ai): one dedicated
// SMS/iMessage/voice number per deployment, reached through one REST API.
//
// This is deliberately NOT the shared-line model that agent/lib/effect/
// imessage.ts implements for Photon Spectrum. There, one central router owns a
// single line and fans deliveries out to paired deployments. Here every
// deployment provisions its own number ($3/month), so there is no router, no
// pairing OTP, and no handle registry — the deployment holds the credential
// and talks to the provider directly. The two run side by side; neither knows
// about the other.
//
// What lives here:
//   AgentPhone — the API client (numbers, messages, calls, webhooks,
//     registration) plus the Neon state the channels need: the provisioned
//     number, the webhook secret, inbound claims, and per-call stream cursors.
//
// The provider's JSON casing is not consistent, and this file encodes that
// rather than smoothing it over: /v1/messages and /v1/register are snake_case,
// everything else is camelCase, and path/query params are always snake_case.
// A normalizing layer would hide the seam and make every field unverifiable
// against the published spec, so each call site spells the wire names out.

/** Texts read badly past a few kB, and each 160-char segment is billed. */
const MAX_SEND_CHARS = 1600;

const HTTP_TIMEOUT = "20 seconds";

/** Where an app-managed key lives when the owner pastes one into the UI. */
const KEY_SETTING = "agentphone-api-key";

const DEFAULT_API_BASE = "https://api.agentphone.ai";

export class AgentPhoneError extends Data.TaggedError("AgentPhoneError")<{
  readonly reason:
    | "not_configured"
    | "no_database"
    | "no_number"
    | "validation"
    | "api"
    | "carrier"
    | "not_registered";
  readonly detail?: string;
  /** HTTP status behind an `api` failure; absent when nothing answered. */
  readonly status?: number;
}> {}

export function describeAgentPhoneError(error: AgentPhoneError): string {
  switch (error.reason) {
    case "not_configured":
      return "No AgentPhone API key. Set AGENTPHONE_API_KEY, or add a key under Manage -> Phone.";
    case "no_database":
      return "The phone needs DATABASE_URL to store its number and webhook secret, and this deployment has no database configured.";
    case "no_number":
      return "No phone number is provisioned yet. Provision one under Manage -> Phone.";
    case "validation":
      return `That input was refused: ${error.detail ?? "invalid value"}`;
    case "api":
      return `AgentPhone rejected the request: ${error.detail ?? "unknown error"}`;
    case "carrier":
      return `The carrier refused that message: ${error.detail ?? "unknown error"}`;
    case "not_registered":
      return "Texting US numbers over SMS needs 10DLC registration, which is not approved yet. iMessage and voice work now; check status under Manage -> Phone.";
  }
}

export type AgentPhoneStoreError = AgentPhoneError | DatabaseError | SchemaError;

// --- Configuration ---------------------------------------------------------

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function hasDatabase(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

/** Base URL of the stub (`scripts/agentphone-stub.mjs`) when repointed. */
export function agentPhoneApiBase(): string {
  return (env("AGENTPHONE_API_BASE_URL") ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

/**
 * The key comes from the environment or, failing that, from the app settings
 * the owner can paste a key into. The environment wins when both exist: it is
 * deployment-level configuration, and a UI-saved leftover should not be able
 * to shadow it. Same rule as Orgo and AgentMail.
 */
export type AgentPhoneKeySource = "env" | "app";

function envKey(): string | null {
  return env("AGENTPHONE_API_KEY");
}

export async function agentPhoneKeySource(): Promise<AgentPhoneKeySource | null> {
  if (envKey() !== null) return "env";
  return (await settingsStore.get(KEY_SETTING)) === null ? null : "app";
}

/** Whether this deployment has a key at all. Gates the whole capability. */
export async function agentPhoneConfigured(): Promise<boolean> {
  return (await agentPhoneKeySource()) !== null;
}

/** Last characters of the active key, so the UI can identify without revealing. */
export async function agentPhoneKeyHint(): Promise<string | null> {
  const key = envKey() ?? (await settingsStore.get(KEY_SETTING));
  return key === null ? null : `...${key.slice(-4)}`;
}

/** Store or clear the app-managed key. `null` clears; the env key is untouched. */
export async function setAppAgentPhoneKey(key: string | null): Promise<void> {
  if (key === null) await settingsStore.delete(KEY_SETTING);
  else await settingsStore.set(KEY_SETTING, key);
}

const resolveKey = Effect.suspend(() =>
  Effect.tryPromise({
    try: async () => envKey() ?? (await settingsStore.get(KEY_SETTING)),
    catch: () => new AgentPhoneError({ reason: "not_configured" }),
  }).pipe(
    Effect.flatMap((key) =>
      key === null || key.length === 0
        ? Effect.fail(new AgentPhoneError({ reason: "not_configured" }))
        : Effect.succeed(key),
    ),
  ),
);

// --- HTTP ------------------------------------------------------------------

/** Carries the status code out of `fetch` so retry policy can see it. */
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpFailure";
  }
}

/**
 * AgentPhone returns two different error envelopes: its own
 * `{ error: { message, code } }`, and FastAPI's native
 * `{ detail: [{ loc, msg }] }` on 422. Read both — a parser that knows only
 * one renders the other as an empty string.
 */
function providerMessage(body: string): { message: string | null; code: string | null } {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return { message: null, code: null };
    const { error, detail } = parsed as { error?: unknown; detail?: unknown };
    if (error !== null && typeof error === "object") {
      const { message, code } = error as { message?: unknown; code?: unknown };
      return {
        message: typeof message === "string" && message.length > 0 ? message : null,
        code: typeof code === "string" && code.length > 0 ? code : null,
      };
    }
    if (Array.isArray(detail)) {
      const first = detail[0] as { msg?: unknown; loc?: unknown } | undefined;
      const field = Array.isArray(first?.loc) ? first.loc.join(".") : null;
      const msg = typeof first?.msg === "string" ? first.msg : null;
      if (msg !== null) return { message: field === null ? msg : `${field}: ${msg}`, code: null };
    }
  } catch {
    // Not JSON.
  }
  const trimmed = body.trim();
  return { message: trimmed.length === 0 ? null : trimmed.slice(0, 300), code: null };
}

/** Transport faults and server/throttle statuses are worth repeating; a 4xx is a decision. */
function isRetryable(error: AgentPhoneError): boolean {
  if (error.status === undefined) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

interface RequestOptions {
  readonly path: string;
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly json?: unknown;
  readonly query?: Record<string, string | number | undefined>;
  /** Scopes the request to a sub-account; omitted targets the master account. */
  readonly subAccountId?: string | null;
}

function request(options: RequestOptions): Effect.Effect<unknown, AgentPhoneError> {
  const attempt = Effect.gen(function* () {
    const key = yield* resolveKey;
    const url = new URL(`${agentPhoneApiBase()}${options.path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const headers: Record<string, string> = {
          accept: "application/json",
          authorization: `Bearer ${key}`,
        };
        let body: string | undefined;
        if (options.json !== undefined) {
          headers["content-type"] = "application/json";
          body = JSON.stringify(options.json);
        }
        if (options.subAccountId != null) headers["x-sub-account-id"] = options.subAccountId;

        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers,
          ...(body === undefined ? {} : { body }),
        });
        const text = await response.text();
        if (!response.ok) {
          const { message, code } = providerMessage(text);
          throw new HttpFailure(
            response.status,
            // The carrier code is the one a caller can actually act on
            // (retry with backoff), so keep it in the message.
            code === null ? (message ?? `HTTP ${response.status}`) : `${code}: ${message ?? ""}`,
          );
        }
        return text.length === 0 ? null : (JSON.parse(text) as unknown);
      },
      catch: (cause) =>
        cause instanceof HttpFailure
          ? new AgentPhoneError({
              reason: cause.message.startsWith("CARRIER_ERROR") ? "carrier" : "api",
              detail: cause.message,
              status: cause.status,
            })
          : new AgentPhoneError({
              reason: "api",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
    });
  });

  return attempt.pipe(
    Effect.retry({ times: 2, while: (error: AgentPhoneError) => isRetryable(error) }),
    Effect.timeoutOrElse({
      duration: HTTP_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new AgentPhoneError({ reason: "api", detail: `no response within ${HTTP_TIMEOUT}` }),
        ),
    }),
  );
}

// --- Wire shapes -----------------------------------------------------------
//
// Kept loose on purpose: the published OpenAPI declares "Any type" for every
// call endpoint, and several documented fields are absent from the spec. Decode
// only what we consume, so an unannounced field never fails a turn.

const NumberRow = Schema.Struct({
  id: Schema.String,
  phoneNumber: Schema.String,
  status: Schema.String,
  agentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** `GET /v1/numbers/{id}/messages` — note `from_`, which is unique to this shape. */
const InboxMessage = Schema.Struct({
  id: Schema.String,
  from_: Schema.String,
  to: Schema.String,
  body: Schema.String,
  direction: Schema.String,
  channel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  receivedAt: Schema.String,
});
export type InboxMessage = typeof InboxMessage.Type;

const SendResult = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  channel: Schema.String,
  from_number: Schema.String,
  to_number: Schema.String,
  conversation_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type SendResult = typeof SendResult.Type;

const Capabilities = Schema.Struct({
  phoneNumber: Schema.String,
  capabilities: Schema.Struct({ imessage: Schema.Boolean, sms: Schema.Boolean }),
});

const WebhookConfig = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  secret: Schema.String,
});

const RegistrationStatus = Schema.Struct({
  campaign_status: Schema.String,
  message: Schema.optionalKey(Schema.NullOr(Schema.String)),
  stage: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type RegistrationStatus = typeof RegistrationStatus.Type;

// --- Rows and views --------------------------------------------------------

const ConfigRow = Schema.Struct({
  number_id: Schema.NullOr(Schema.String),
  phone_number: Schema.NullOr(Schema.String),
  agent_id: Schema.NullOr(Schema.String),
  webhook_secret: Schema.NullOr(Schema.String),
  owner_number: Schema.NullOr(Schema.String),
});

export interface PhoneView {
  readonly numberId: string | null;
  readonly phoneNumber: string | null;
  readonly agentId: string | null;
  readonly webhookRegistered: boolean;
  /** The owner's own number. Everyone else who calls or texts is a guest. */
  readonly ownerNumber: string | null;
}

/** The provisioned line, with the secret, for code that must verify a delivery. */
export interface VerifiedPhone {
  readonly numberId: string;
  readonly phoneNumber: string;
  readonly agentId: string | null;
  readonly webhookSecret: string;
  readonly ownerNumber: string | null;
}

// --- Small helpers ---------------------------------------------------------

/** E.164 if we can get there; `null` when the input is not a phone number. */
export function normalizeNumber(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^grp_[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed; // group id passes through
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

/**
 * Splits a reply into sendable chunks at the nicest seam available. Long
 * replies are billed per 160-char segment either way, but breaking mid-word
 * reads as a glitch where breaking at a paragraph reads as two texts.
 */
export function splitMessageText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_SEND_CHARS) return trimmed.length === 0 ? [] : [trimmed];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > MAX_SEND_CHARS) {
    const window = rest.slice(0, MAX_SEND_CHARS);
    const seam = ["\n\n", "\n", " "]
      .map((sep) => window.lastIndexOf(sep))
      .find((index) => index > MAX_SEND_CHARS / 2);
    const cut = seam ?? MAX_SEND_CHARS;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

// --- Service ---------------------------------------------------------------

export class AgentPhone extends Context.Service<AgentPhone, {
  /** The provisioned line as the UI sees it; never throws when unconfigured. */
  readonly view: () => Effect.Effect<PhoneView, AgentPhoneStoreError>;
  /** The line plus its webhook secret, or null when nothing is provisioned. */
  readonly verified: () => Effect.Effect<VerifiedPhone | null, AgentPhoneStoreError>;
  /**
   * Buys a number (or adopts the account's first active one), creates the
   * agent that owns it, and points the webhook at `callbackUrl`. Idempotent:
   * a deployment that already has a number re-registers the webhook instead
   * of buying a second $3/month line.
   */
  readonly provision: (input: {
    readonly callbackUrl: string;
    readonly areaCode?: string;
  }) => Effect.Effect<PhoneView, AgentPhoneStoreError>;
  /** Releases the number upstream and forgets it locally. */
  readonly release: () => Effect.Effect<PhoneView, AgentPhoneStoreError>;
  /** Records whose texts and calls count as the owner's. */
  readonly setOwnerNumber: (
    ownerNumber: string | null,
  ) => Effect.Effect<PhoneView, AgentPhoneStoreError>;
  readonly send: (input: {
    readonly to: string;
    readonly text: string;
    readonly mediaUrls?: readonly string[];
    readonly replyToMessageId?: string;
    readonly sendStyle?: string;
  }) => Effect.Effect<readonly SendResult[], AgentPhoneStoreError>;
  readonly react: (input: {
    readonly messageId: string;
    readonly reaction: string;
  }) => Effect.Effect<void, AgentPhoneStoreError>;
  readonly typing: (conversationId: string) => Effect.Effect<void, AgentPhoneStoreError>;
  /** Inbound messages on our line, newest first. The verification inbox. */
  readonly inbox: (input: {
    readonly limit: number;
    readonly since?: string;
  }) => Effect.Effect<readonly InboxMessage[], AgentPhoneStoreError>;
  readonly canIMessage: (
    phoneNumber: string,
  ) => Effect.Effect<{ imessage: boolean; sms: boolean }, AgentPhoneStoreError>;
  readonly placeCall: (input: {
    readonly to: string;
    readonly greeting?: string;
    readonly systemPrompt?: string;
  }) => Effect.Effect<{ callId: string | null }, AgentPhoneStoreError>;
  readonly registrationStatus: () => Effect.Effect<RegistrationStatus, AgentPhoneStoreError>;
  /**
   * Claims one inbound message. "new" — this request owns it; "pending" — an
   * earlier claim never dispatched (a retry may re-enter the batching flow);
   * "done" — already dispatched, drop the retry.
   */
  readonly claimInbound: (input: {
    readonly messageId: string;
    readonly conversationId: string;
    readonly sender: string;
    readonly text: string | null;
  }) => Effect.Effect<"new" | "pending" | "done", AgentPhoneStoreError>;
  readonly settleInbound: (input: {
    readonly messageId: string;
    readonly conversationId: string;
    readonly sender: string;
  }) => Effect.Effect<
    { dispatch: false } | { dispatch: true; batch: readonly { messageId: string; text: string | null }[] },
    AgentPhoneStoreError
  >;
  readonly recordInboundBatch: (input: {
    readonly batchMessageIds: readonly string[];
    readonly status: "ok" | "error";
    readonly error?: string;
  }) => Effect.Effect<void, AgentPhoneStoreError>;
  readonly releaseInboundBatch: (input: {
    readonly batchMessageIds: readonly string[];
    readonly ownMessageId: string;
  }) => Effect.Effect<void, AgentPhoneStoreError>;
  /** Where this call's event stream was last read to, for the voice bridge. */
  readonly callCursor: (callId: string) => Effect.Effect<number, AgentPhoneStoreError>;
  readonly setCallCursor: (input: {
    readonly callId: string;
    readonly cursor: number;
  }) => Effect.Effect<void, AgentPhoneStoreError>;
}>()("AgentPhone") {}

export const AgentPhoneLive = Layer.effect(
  AgentPhone,
  Effect.gen(function* () {
    const database = yield* Db;

    const decodeConfigRows = Schema.decodeUnknownEffect(Schema.Array(ConfigRow));
    const decodeNumber = Schema.decodeUnknownEffect(NumberRow);
    const decodeNumbers = Schema.decodeUnknownEffect(Schema.Array(NumberRow));
    const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(InboxMessage));
    const decodeSend = Schema.decodeUnknownEffect(SendResult);
    const decodeCapabilities = Schema.decodeUnknownEffect(Capabilities);
    const decodeWebhook = Schema.decodeUnknownEffect(WebhookConfig);
    const decodeRegistration = Schema.decodeUnknownEffect(RegistrationStatus);

    let tablesReady = false;
    const ensureTables = Effect.suspend(() =>
      tablesReady
        ? Effect.void
        : Effect.gen(function* () {
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS agentphone_config (
                 id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                 number_id text,
                 phone_number text,
                 agent_id text,
                 webhook_secret text,
                 owner_number text,
                 updated_at timestamptz NOT NULL DEFAULT now()
               )`,
            );
            // Deployments created before guest attribution learn it in place.
            yield* database.query(
              `ALTER TABLE agentphone_config ADD COLUMN IF NOT EXISTS owner_number text`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS agentphone_inbound (
                 message_id text PRIMARY KEY,
                 conversation_id text NOT NULL,
                 sender text NOT NULL,
                 claimed_at timestamptz NOT NULL DEFAULT now(),
                 status text NOT NULL DEFAULT 'claimed',
                 error text,
                 text text
               )`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS agentphone_call (
                 call_id text PRIMARY KEY,
                 cursor integer NOT NULL DEFAULT 0,
                 updated_at timestamptz NOT NULL DEFAULT now()
               )`,
            );
            tablesReady = true;
          }),
    );

    const requireDatabase = Effect.suspend(() =>
      hasDatabase() ? Effect.void : Effect.fail(new AgentPhoneError({ reason: "no_database" })),
    );

    const readConfig = Effect.gen(function* () {
      yield* ensureTables;
      const rows = yield* database.query(
        `SELECT number_id, phone_number, agent_id, webhook_secret, owner_number
           FROM agentphone_config WHERE id = 1`,
      );
      const decoded = yield* decodeConfigRows(rows);
      return decoded.length > 0 ? decoded[0] : null;
    });

    /** The provisioned line, or a typed refusal. Every send path opens with this. */
    const requireNumber = Effect.gen(function* () {
      yield* requireDatabase;
      const row = yield* readConfig;
      if (row === null || row.number_id === null || row.phone_number === null) {
        return yield* Effect.fail(new AgentPhoneError({ reason: "no_number" }));
      }
      return { numberId: row.number_id, phoneNumber: row.phone_number, agentId: row.agent_id };
    });

    const writeConfig = (input: {
      numberId: string | null;
      phoneNumber: string | null;
      agentId: string | null;
      webhookSecret: string | null;
    }) =>
      // owner_number is deliberately absent: it is set on its own and must
      // survive a re-provision, which would otherwise silently demote the
      // owner to a guest and lock them out of their own tools.
      database.query(
        `INSERT INTO agentphone_config (id, number_id, phone_number, agent_id, webhook_secret)
         VALUES (1, $1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET number_id = EXCLUDED.number_id,
               phone_number = EXCLUDED.phone_number,
               agent_id = EXCLUDED.agent_id,
               webhook_secret = EXCLUDED.webhook_secret,
               updated_at = now()`,
        [input.numberId, input.phoneNumber, input.agentId, input.webhookSecret],
      );

    const toView = (row: typeof ConfigRow.Type | null): PhoneView => ({
      numberId: row?.number_id ?? null,
      phoneNumber: row?.phone_number ?? null,
      agentId: row?.agent_id ?? null,
      webhookRegistered: (row?.webhook_secret ?? null) !== null,
      ownerNumber: row?.owner_number ?? null,
    });

    return {
      view: () =>
        Effect.gen(function* () {
          if (!hasDatabase()) return toView(null);
          return toView(yield* readConfig);
        }),

      verified: () =>
        Effect.gen(function* () {
          // A read-only probe: callers treat "no phone" as a normal state, so
          // an unconfigured deployment answers null rather than failing.
          if (!hasDatabase()) return null;
          const row = yield* readConfig;
          if (row === null) return null;
          const { number_id, phone_number, webhook_secret } = row;
          if (number_id === null || phone_number === null || webhook_secret === null) return null;
          return {
            numberId: number_id,
            phoneNumber: phone_number,
            agentId: row.agent_id,
            webhookSecret: webhook_secret,
            ownerNumber: row.owner_number,
          };
        }),

      setOwnerNumber: (ownerNumber) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          yield* ensureTables;
          const normalized = ownerNumber === null ? null : normalizeNumber(ownerNumber);
          if (ownerNumber !== null && normalized === null) {
            return yield* Effect.fail(
              new AgentPhoneError({
                reason: "validation",
                detail: `${ownerNumber} is not a phone number`,
              }),
            );
          }
          yield* database.query(
            `INSERT INTO agentphone_config (id, owner_number)
             VALUES (1, $1)
             ON CONFLICT (id) DO UPDATE SET owner_number = EXCLUDED.owner_number, updated_at = now()`,
            [normalized],
          );
          return toView(yield* readConfig);
        }),

      provision: (input) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          const existing = yield* readConfig;

          let numberId = existing?.number_id ?? null;
          let phoneNumber = existing?.phone_number ?? null;
          let agentId = existing?.agent_id ?? null;

          if (agentId === null) {
            // Webhook mode: transcripts come to us and Ruth answers with her
            // own tools and memory. Hosted mode would put a second, separate
            // LLM on the line that knows nothing about her.
            const created = yield* request({
              path: "/v1/agents",
              method: "POST",
              json: {
                name: "Ruth",
                voiceMode: "webhook",
                enableMessaging: true,
                callScreeningIdentity: "Ruth",
                callScreeningPurpose: "Personal assistant returning a call",
              },
            });
            const id = (created as { id?: unknown } | null)?.id;
            if (typeof id !== "string") {
              return yield* Effect.fail(
                new AgentPhoneError({ reason: "api", detail: "agent create returned no id" }),
              );
            }
            agentId = id;
          }

          if (numberId === null) {
            // Adopt an active number the account already holds before buying:
            // re-running provision after a partial failure must not spend
            // another $3/month.
            const listed = yield* request({ path: "/v1/numbers", query: { limit: 100 } });
            const rows = yield* decodeNumbers(
              (listed as { data?: unknown } | null)?.data ?? [],
            ).pipe(Effect.orElseSucceed(() => []));
            const active = rows.find((row) => row.status === "active");
            if (active !== undefined) {
              numberId = active.id;
              phoneNumber = active.phoneNumber;
            } else {
              const bought = yield* request({
                path: "/v1/numbers",
                method: "POST",
                json: {
                  country: "US",
                  ...(input.areaCode === undefined ? {} : { areaCode: input.areaCode }),
                  agentId,
                },
              });
              const row = yield* decodeNumber(bought);
              numberId = row.id;
              phoneNumber = row.phoneNumber;
            }
          }

          yield* request({
            path: `/v1/agents/${agentId}/numbers`,
            method: "POST",
            json: { numberId },
          }).pipe(
            // Already attached is the common case on a re-run, and the API
            // has no idempotent form; a failure here must not undo the buy.
            Effect.ignore,
          );

          // The webhook secret is minted fresh on every create AND update, so
          // whatever comes back is the only copy — persist it in the same
          // transaction-shaped step that records the number.
          const hook = yield* request({
            path: "/v1/webhooks",
            method: "POST",
            json: { url: input.callbackUrl, contextLimit: 0, timeout: 120 },
          });
          const webhook = yield* decodeWebhook(hook);

          yield* writeConfig({
            numberId,
            phoneNumber,
            agentId,
            webhookSecret: webhook.secret,
          });
          return toView(yield* readConfig);
        }),

      release: () =>
        Effect.gen(function* () {
          yield* requireDatabase;
          const row = yield* readConfig;
          if (row?.number_id != null) {
            yield* request({ path: `/v1/numbers/${row.number_id}`, method: "DELETE" }).pipe(
              // The row must clear even when the upstream release fails, or a
              // stale id blocks re-provisioning forever.
              Effect.ignore,
            );
          }
          yield* writeConfig({
            numberId: null,
            phoneNumber: null,
            agentId: null,
            webhookSecret: null,
          });
          return toView(yield* readConfig);
        }),

      send: (input) =>
        Effect.gen(function* () {
          const line = yield* requireNumber;
          const to = normalizeNumber(input.to);
          if (to === null) {
            return yield* Effect.fail(
              new AgentPhoneError({
                reason: "validation",
                detail: `${input.to} is not a phone number or group id`,
              }),
            );
          }
          const chunks = splitMessageText(input.text);
          const media = input.mediaUrls ?? [];
          if (chunks.length === 0 && media.length === 0) {
            return yield* Effect.fail(
              new AgentPhoneError({ reason: "validation", detail: "nothing to send" }),
            );
          }

          const results: SendResult[] = [];
          // Sequential, not concurrent: texts arrive in send order, and a
          // burst sent in parallel can land shuffled on the recipient.
          for (const [index, chunk] of (chunks.length === 0 ? [""] : chunks).entries()) {
            const last = index === (chunks.length === 0 ? 1 : chunks.length) - 1;
            const sent = yield* request({
              path: "/v1/messages",
              method: "POST",
              json: {
                to_number: to,
                body: chunk,
                number_id: line.numberId,
                // Media rides on the final chunk so the text reads first.
                ...(last && media.length > 0 ? { media_urls: media } : {}),
                ...(index === 0 && input.replyToMessageId !== undefined
                  ? { reply_to_message_id: input.replyToMessageId }
                  : {}),
                ...(index === 0 && input.sendStyle !== undefined
                  ? { send_style: input.sendStyle }
                  : {}),
              },
            });
            results.push(yield* decodeSend(sent));
          }
          return results;
        }),

      react: (input) =>
        request({
          path: `/v1/messages/${input.messageId}/reactions`,
          method: "POST",
          json: { reaction: input.reaction },
        }).pipe(Effect.asVoid),

      typing: (conversationId) =>
        request({
          path: `/v1/conversations/${conversationId}/typing`,
          method: "POST",
          json: {},
        }).pipe(
          // Best-effort everywhere: dropped for non-iMessage recipients, and a
          // missing typing bubble must never fail a turn.
          Effect.ignore,
        ),

      inbox: (input) =>
        Effect.gen(function* () {
          const line = yield* requireNumber;
          const listed = yield* request({
            path: `/v1/numbers/${line.numberId}/messages`,
            query: { limit: input.limit, after: input.since },
          });
          const rows = yield* decodeInbox((listed as { data?: unknown } | null)?.data ?? []);
          return rows.filter((row) => row.direction === "inbound");
        }),

      canIMessage: (phoneNumber) =>
        Effect.gen(function* () {
          const normalized = normalizeNumber(phoneNumber);
          if (normalized === null) {
            return yield* Effect.fail(
              new AgentPhoneError({ reason: "validation", detail: `${phoneNumber} is not a phone number` }),
            );
          }
          const checked = yield* request({
            path: "/v1/contacts/capabilities",
            query: { phone_number: normalized },
          });
          const decoded = yield* decodeCapabilities(checked);
          return decoded.capabilities;
        }),

      placeCall: (input) =>
        Effect.gen(function* () {
          const line = yield* requireNumber;
          if (line.agentId === null) {
            return yield* Effect.fail(
              new AgentPhoneError({ reason: "no_number", detail: "the line has no agent" }),
            );
          }
          const to = normalizeNumber(input.to);
          if (to === null) {
            return yield* Effect.fail(
              new AgentPhoneError({ reason: "validation", detail: `${input.to} is not a phone number` }),
            );
          }
          const placed = yield* request({
            path: "/v1/calls",
            method: "POST",
            json: {
              agentId: line.agentId,
              toNumber: to,
              fromNumberId: line.numberId,
              ...(input.greeting === undefined ? {} : { initialGreeting: input.greeting }),
              // A systemPrompt switches this one call to the provider's hosted
              // LLM, which is the right trade for a scripted errand: no
              // webhook round-trip, no 30s budget, nothing for Ruth to hold.
              ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
            },
          });
          const id = (placed as { id?: unknown; callId?: unknown } | null) ?? {};
          const callId =
            typeof id.id === "string" ? id.id : typeof id.callId === "string" ? id.callId : null;
          return { callId };
        }),

      registrationStatus: () =>
        Effect.gen(function* () {
          const status = yield* request({ path: "/v1/register/status" });
          return yield* decodeRegistration(status);
        }),

      claimInbound: (input) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          yield* ensureTables;
          const inserted = yield* database.query(
            `INSERT INTO agentphone_inbound (message_id, conversation_id, sender, text)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (message_id) DO NOTHING
             RETURNING message_id`,
            [input.messageId, input.conversationId, input.sender, input.text],
          );
          if (inserted.length > 0) return "new" as const;
          const existing = yield* database.query(
            `SELECT status FROM agentphone_inbound WHERE message_id = $1`,
            [input.messageId],
          );
          const status = (existing[0] as { status?: string } | undefined)?.status ?? "ok";
          // An undispatched row means the original request may have died; the
          // retry re-enters the settle flow, where the stale window decides.
          return status === "claimed" || status === "dispatching"
            ? ("pending" as const)
            : ("done" as const);
        }),

      settleInbound: (input) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          yield* ensureTables;
          // Undispatched claims, plus in-flight rows old enough that their
          // dispatcher must be dead.
          const drainable = `(status = 'claimed'
               OR (status = 'dispatching' AND claimed_at < now() - interval '90 seconds'))`;
          const newest = yield* database.query(
            `SELECT message_id FROM agentphone_inbound
              WHERE sender = $1 AND conversation_id = $2 AND ${drainable}
              ORDER BY claimed_at DESC, message_id DESC
              LIMIT 1`,
            [input.sender, input.conversationId],
          );
          const newestId = (newest[0] as { message_id?: string } | undefined)?.message_id;
          // Only the newest message's request dispatches; older ones leave
          // their text queued for it.
          if (newestId !== input.messageId) return { dispatch: false as const };

          const drained = yield* database.query(
            `WITH drained AS (
               UPDATE agentphone_inbound
                  SET status = 'dispatching'
                WHERE sender = $1 AND conversation_id = $2 AND ${drainable}
                RETURNING message_id, text, claimed_at
             )
             SELECT message_id, text FROM drained ORDER BY claimed_at ASC, message_id ASC`,
            [input.sender, input.conversationId],
          );
          const batch = drained.map((row) => {
            const record = row as { message_id?: string; text?: string | null };
            return { messageId: record.message_id ?? "", text: record.text ?? null };
          });
          // Losing the whole drain to a concurrent settle means that settle
          // dispatches these texts; nothing is dropped by standing down.
          if (!batch.some((entry) => entry.messageId === input.messageId)) {
            return { dispatch: false as const };
          }
          return { dispatch: true as const, batch };
        }),

      recordInboundBatch: (input) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          yield* ensureTables;
          yield* database.query(
            `UPDATE agentphone_inbound SET status = $2, error = $3
              WHERE message_id = ANY($1::text[])`,
            [[...input.batchMessageIds], input.status, input.error ?? null],
          );
        }),

      releaseInboundBatch: (input) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          yield* ensureTables;
          // Others go back to the queue for the next drain; the caller's own
          // row is deleted so the provider's retry sees "new" and reprocesses
          // it. Without the delete, the retry hits "pending" and the message
          // is stuck forever.
          yield* database.query(
            `UPDATE agentphone_inbound SET status = 'claimed'
              WHERE message_id = ANY($1::text[]) AND message_id <> $2`,
            [[...input.batchMessageIds], input.ownMessageId],
          );
          yield* database.query(`DELETE FROM agentphone_inbound WHERE message_id = $1`, [
            input.ownMessageId,
          ]);
        }),

      callCursor: (callId) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          yield* ensureTables;
          const rows = yield* database.query(
            `SELECT cursor FROM agentphone_call WHERE call_id = $1`,
            [callId],
          );
          const cursor = (rows[0] as { cursor?: number } | undefined)?.cursor;
          return typeof cursor === "number" ? cursor : 0;
        }),

      setCallCursor: (input) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          yield* ensureTables;
          yield* database.query(
            `INSERT INTO agentphone_call (call_id, cursor)
             VALUES ($1, $2)
             ON CONFLICT (call_id) DO UPDATE
               SET cursor = EXCLUDED.cursor, updated_at = now()`,
            [input.callId, input.cursor],
          );
        }),
    };
  }),
);

// --- Accessors -------------------------------------------------------------
//
// Build programs against the service without resolving it, so channels, tools,
// and routes stay one-liners and tests can swap the layer.

export const agentPhoneView = (): Effect.Effect<PhoneView, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).view();
  });

export const verifiedPhone = (): Effect.Effect<
  VerifiedPhone | null,
  AgentPhoneStoreError,
  AgentPhone
> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).verified();
  });

export const provisionPhone = (input: {
  readonly callbackUrl: string;
  readonly areaCode?: string;
}): Effect.Effect<PhoneView, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).provision(input);
  });

export const releasePhone = (): Effect.Effect<PhoneView, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).release();
  });

export const setPhoneOwnerNumber = (
  ownerNumber: string | null,
): Effect.Effect<PhoneView, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).setOwnerNumber(ownerNumber);
  });

export const sendText = (input: {
  readonly to: string;
  readonly text: string;
  readonly mediaUrls?: readonly string[];
  readonly replyToMessageId?: string;
  readonly sendStyle?: string;
}): Effect.Effect<readonly SendResult[], AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).send(input);
  });

export const reactToText = (input: {
  readonly messageId: string;
  readonly reaction: string;
}): Effect.Effect<void, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).react(input);
  });

export const sendTypingIndicator = (
  conversationId: string,
): Effect.Effect<void, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).typing(conversationId);
  });

export const phoneInbox = (input: {
  readonly limit: number;
  readonly since?: string;
}): Effect.Effect<readonly InboxMessage[], AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).inbox(input);
  });

export const checkIMessageCapability = (
  phoneNumber: string,
): Effect.Effect<{ imessage: boolean; sms: boolean }, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).canIMessage(phoneNumber);
  });

export const placePhoneCall = (input: {
  readonly to: string;
  readonly greeting?: string;
  readonly systemPrompt?: string;
}): Effect.Effect<{ callId: string | null }, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).placeCall(input);
  });

export const phoneRegistrationStatus = (): Effect.Effect<
  RegistrationStatus,
  AgentPhoneStoreError,
  AgentPhone
> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).registrationStatus();
  });

export const claimPhoneInbound = (input: {
  readonly messageId: string;
  readonly conversationId: string;
  readonly sender: string;
  readonly text: string | null;
}): Effect.Effect<"new" | "pending" | "done", AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).claimInbound(input);
  });

export const settlePhoneInbound = (input: {
  readonly messageId: string;
  readonly conversationId: string;
  readonly sender: string;
}): Effect.Effect<
  { dispatch: false } | { dispatch: true; batch: readonly { messageId: string; text: string | null }[] },
  AgentPhoneStoreError,
  AgentPhone
> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).settleInbound(input);
  });

export const recordPhoneInboundBatch = (input: {
  readonly batchMessageIds: readonly string[];
  readonly status: "ok" | "error";
  readonly error?: string;
}): Effect.Effect<void, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).recordInboundBatch(input);
  });

export const releasePhoneInboundBatch = (input: {
  readonly batchMessageIds: readonly string[];
  readonly ownMessageId: string;
}): Effect.Effect<void, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).releaseInboundBatch(input);
  });

export const phoneCallCursor = (
  callId: string,
): Effect.Effect<number, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).callCursor(callId);
  });

export const setPhoneCallCursor = (input: {
  readonly callId: string;
  readonly cursor: number;
}): Effect.Effect<void, AgentPhoneStoreError, AgentPhone> =>
  Effect.gen(function* () {
    return yield* (yield* AgentPhone).setCallCursor(input);
  });
