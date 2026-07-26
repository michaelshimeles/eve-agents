import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import { Context, Data, Effect, Layer, Schema } from "effect";
import type { SchemaError } from "effect/SchemaError";

import { type DatabaseError, Db } from "./db";

// iMessage over Photon's Spectrum (https://photon.codes), shared-number model:
// one Photon Business project with a dedicated line is operated centrally, and
// every eveclaw deployment talks to that line through a router. The router is
// this same app with SPECTRUM_* credentials set — it owns the Spectrum webhook
// and the project secret, keeps a Neon registry mapping each paired phone
// number (or iMessage email) to its deployment, forwards inbound texts, and
// sends replies on a deployment's behalf. Deployments hold no Photon
// credentials at all: they pair once (OTP texted from the shared number,
// entered in Manage -> iMessage) and from then on receive router-signed
// deliveries on /eve/v1/imessage/inbound and reply through the router's
// /api/imessage/send.
//
// Two services live here because one app can play both parts:
//   IMessagePairing — deployment side: the pairing row, inbound claims, and
//     HTTP calls to the router.
//   IMessageRouter — router side: the handle registry, OTP pair requests, and
//     the actual Spectrum sends (SDK, or the stub behind SPECTRUM_API_BASE_URL).

/** Spectrum caps nothing this low, but texts read badly past a few kB. */
const MAX_SEND_CHARS = 4000;

const HTTP_TIMEOUT = "20 seconds";

/** An unverified pair request dies after this long. */
const PAIR_REQUEST_TTL_MS = 10 * 60_000;

/** Wrong-code guesses allowed before the pair request is burned. */
const MAX_VERIFY_ATTEMPTS = 5;

/** New OTP texts allowed per handle per hour — the line's send is not free. */
const MAX_PAIR_REQUESTS_PER_HOUR = 3;

/**
 * OTP texts allowed per hour across all handles. /pair is unauthenticated by
 * design (the OTP is the proof), so without a global cap someone rotating
 * handles could turn the shared line into a spam cannon and burn its
 * 50-new-contacts-per-day allowance.
 */
const MAX_PAIR_REQUESTS_PER_HOUR_TOTAL = 10;

export class IMessageError extends Data.TaggedError("IMessageError")<{
  readonly reason:
    | "not_configured"
    | "no_database"
    | "not_paired"
    | "validation"
    | "pairing"
    | "router"
    | "spectrum";
  readonly detail?: string;
  /** HTTP status behind a `router` failure; absent when nothing answered. */
  readonly status?: number;
}> {}

export function describeIMessageError(error: IMessageError): string {
  switch (error.reason) {
    case "not_configured":
      return "iMessage is not configured on this deployment: no router is reachable and no Spectrum credentials are set.";
    case "no_database":
      return "iMessage pairing needs DATABASE_URL to store its state, and this deployment has no database configured.";
    case "not_paired":
      return "This deployment is not paired with an iMessage number yet. Pair it under Manage -> iMessage.";
    case "validation":
      return `That input was refused: ${error.detail ?? "invalid value"}`;
    case "pairing":
      return `Pairing failed: ${error.detail ?? "unknown error"}`;
    case "router":
      return `The iMessage router rejected the request: ${error.detail ?? "unknown error"}`;
    case "spectrum":
      return `Sending over iMessage failed: ${error.detail ?? "unknown error"}`;
  }
}

export type IMessageStoreError = IMessageError | DatabaseError | SchemaError;

// --- Configuration ---------------------------------------------------------

function hasDatabase(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

/** Base URL of the Spectrum stub (`scripts/spectrum-stub.mjs`), when set. */
export function spectrumStubBaseUrl(): string | null {
  return env("SPECTRUM_API_BASE_URL");
}

export function spectrumWebhookSecret(): string | null {
  return env("SPECTRUM_WEBHOOK_SECRET");
}

/** True when this deployment can send through Spectrum (SDK or stub). */
function spectrumSendConfigured(): boolean {
  if (spectrumStubBaseUrl() !== null) return true;
  return env("SPECTRUM_PROJECT_ID") !== null && env("SPECTRUM_PROJECT_SECRET") !== null;
}

/**
 * True when this deployment is the router: it can verify Spectrum webhook
 * deliveries and send messages out through the shared line.
 */
export function imessageRouterConfigured(): boolean {
  return spectrumWebhookSecret() !== null && spectrumSendConfigured();
}

/**
 * The router this deployment pairs against. An explicit IMESSAGE_ROUTER_URL
 * wins; a deployment that is itself the router defaults to its own origin.
 */
export function defaultRouterUrl(selfOrigin: string): string | null {
  const configured = env("IMESSAGE_ROUTER_URL");
  if (configured !== null) return configured.replace(/\/+$/, "");
  if (imessageRouterConfigured()) return selfOrigin.replace(/\/+$/, "");
  return null;
}

// --- Handles -----------------------------------------------------------------

/**
 * Canonical form of an iMessage handle: E.164 (`+15551234567`) or an email
 * address, lowercased. Returns null for anything else — the caller decides
 * whether that is a 400 or a silent drop.
 */
export function normalizeHandle(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  }
  const digits = trimmed.replace(/[\s\-().]/g, "");
  return /^\+[0-9]{7,15}$/.test(digits) ? digits : null;
}

// --- Spectrum wire shapes ----------------------------------------------------

// The webhook body for the one event Spectrum emits today ("messages"):
// https://photon.codes/docs/webhooks/events. Kept loose on purpose — new
// fields and content arms arrive without a version bump.

export const SpectrumDelivery = Schema.Struct({
  event: Schema.String,
  space: Schema.Struct({
    id: Schema.String,
    type: Schema.optionalKey(Schema.String),
    phone: Schema.optionalKey(Schema.String),
  }),
  message: Schema.Struct({
    id: Schema.String,
    timestamp: Schema.optionalKey(Schema.String),
    sender: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
    content: Schema.Unknown,
  }),
});
export type SpectrumDelivery = typeof SpectrumDelivery.Type;

/** The delivery decoded from raw webhook bytes, or null when malformed. */
export function parseSpectrumDelivery(rawBody: string): SpectrumDelivery | null {
  try {
    return Schema.decodeUnknownSync(SpectrumDelivery)(JSON.parse(rawBody));
  } catch {
    return null;
  }
}

interface ContentArm {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly name?: unknown;
  readonly mimeType?: unknown;
  readonly url?: unknown;
  readonly items?: unknown;
}

function asArm(content: unknown): ContentArm | null {
  return content !== null && typeof content === "object" ? (content as ContentArm) : null;
}

/**
 * The model-facing text for one inbound content arm. Byte-bearing arms ship
 * metadata only (no bytes, no URL), so attachments become an honest note the
 * agent can react to. Returns null for arms that should not wake the agent
 * at all (reactions, unknown future arms).
 */
export function renderInboundText(content: unknown): string | null {
  const arm = asArm(content);
  if (arm === null) return null;
  switch (arm.type) {
    case "text":
      return typeof arm.text === "string" && arm.text.trim().length > 0 ? arm.text : null;
    case "attachment": {
      const name = typeof arm.name === "string" ? arm.name : "unnamed file";
      const mime = typeof arm.mimeType === "string" ? arm.mimeType : "unknown type";
      return `[The sender attached a file you cannot open from here: ${name} (${mime}). Ask them to describe it or send text instead.]`;
    }
    case "richlink":
      return typeof arm.url === "string" ? arm.url : null;
    case "group": {
      const items = Array.isArray(arm.items) ? arm.items : [];
      const parts = items
        .map((item) => renderInboundText((item as { content?: unknown }).content))
        .filter((part): part is string => part !== null);
      return parts.length > 0 ? parts.join("\n") : null;
    }
    default:
      // Reactions and future arms: acknowledged to Spectrum, ignored here.
      return null;
  }
}

// --- Rows and views ----------------------------------------------------------

const PairingRow = Schema.Struct({
  router_url: Schema.String,
  handle: Schema.String,
  status: Schema.Literals(["pending", "verified"]),
  pairing_id: Schema.NullOr(Schema.String),
  secret: Schema.NullOr(Schema.String),
  requested_at: Schema.String,
  verified_at: Schema.NullOr(Schema.String),
});
type PairingRow = typeof PairingRow.Type;

export interface PairingView {
  readonly status: "unpaired" | "pending" | "verified";
  readonly handle: string | null;
  readonly routerUrl: string | null;
  readonly verifiedAt: string | null;
}

export interface VerifiedPairing {
  readonly routerUrl: string;
  readonly handle: string;
  readonly secret: string;
}

// The registry keeps each deployment's secret as plaintext: the router signs
// every forwarded delivery with it, so a hash would not do — and Neon already
// holds transcripts and app-managed keys, making it the trust boundary anyway
// (same posture as lib/settings-db.ts).
const RegistryRow = Schema.Struct({
  handle: Schema.String,
  deployment_url: Schema.String,
  secret: Schema.String,
  verified_at: Schema.String,
});
type RegistryRow = typeof RegistryRow.Type;

const PairRequestRow = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  deployment_url: Schema.String,
  code_hash: Schema.String,
  attempts: Schema.Int,
  expires_at_ms: Schema.Finite,
  /** Handle this pairing replaces — recorded only with proof (its secret). */
  supersedes_handle: Schema.NullOr(Schema.String),
  /** The exact secret proven at begin; the delete matches on it so a row
   * re-paired before this request verifies is never mistaken for the one
   * authenticated. */
  supersedes_secret: Schema.NullOr(Schema.String),
});

const PairBeginResponse = Schema.Struct({ pairingId: Schema.String });
const PairVerifyResponse = Schema.Struct({ handle: Schema.String, secret: Schema.String });

// --- Small helpers -----------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Compares through hashes so mismatched lengths still take constant time. */
function secretsMatch(expected: string, provided: string): boolean {
  return timingSafeEqual(Buffer.from(sha256Hex(expected)), Buffer.from(sha256Hex(provided)));
}

function hashesMatch(expectedHash: string, provided: string): boolean {
  const a = Buffer.from(expectedHash);
  const b = Buffer.from(sha256Hex(provided));
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Long replies become several texts, split at paragraph seams when possible. */
export function splitMessageText(text: string): string[] {
  if (text.length <= MAX_SEND_CHARS) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_SEND_CHARS) {
    const window = rest.slice(0, MAX_SEND_CHARS);
    const seam = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = seam > MAX_SEND_CHARS / 2 ? seam : MAX_SEND_CHARS;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

// --- HTTP (deployment -> router) ---------------------------------------------

interface PostJsonOptions {
  readonly url: string;
  readonly json: unknown;
  readonly bearer?: string;
}

/** Carries the status code out of `fetch` so the error can surface it. */
class HttpFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpFailure";
    this.status = status;
  }
}

/** One error line out of a router response body, JSON `{error}` or raw text. */
function routerMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const { error } = parsed as { error?: unknown };
      if (typeof error === "string" && error.length > 0) return error;
    }
  } catch {
    // Not JSON.
  }
  const trimmed = body.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 300);
}

/**
 * One POST against the router. Never retried: /pair sends an OTP text and
 * /send delivers a message, so repeating a request whose response was lost
 * would duplicate a user-visible side effect.
 */
function postJson(options: PostJsonOptions): Effect.Effect<unknown, IMessageError> {
  return Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json",
      };
      if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
      const response = await fetch(options.url, {
        method: "POST",
        headers,
        body: JSON.stringify(options.json),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new HttpFailure(response.status, routerMessage(text) ?? `HTTP ${response.status}`);
      }
      return text.length === 0 ? null : (JSON.parse(text) as unknown);
    },
    catch: (cause) =>
      cause instanceof HttpFailure
        ? new IMessageError({ reason: "router", detail: cause.message, status: cause.status })
        : new IMessageError({
            reason: "router",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: HTTP_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new IMessageError({ reason: "router", detail: `no response within ${HTTP_TIMEOUT}` }),
        ),
    }),
  );
}

// --- Spectrum sends (router side) ---------------------------------------------

type SendFn = (handle: string, text: string, phone: string | null) => Promise<void>;

// The SDK instance discovers the project's lines and renews their tokens, so
// it is built once per process and shared across sends.
let sdkSender: Promise<SendFn> | null = null;

function spectrumSdkSender(): Promise<SendFn> {
  sdkSender ??= (async () => {
    const [{ Spectrum }, { imessage }] = await Promise.all([
      import("@spectrum-ts/core"),
      import("@spectrum-ts/imessage"),
    ]);
    const app = await Spectrum({
      projectId: env("SPECTRUM_PROJECT_ID") ?? "",
      projectSecret: env("SPECTRUM_PROJECT_SECRET") ?? "",
      providers: [imessage.config()],
    });
    const im = imessage(app);
    return async (handle, text, phone) => {
      const user = await im.user(handle);
      const space = await (phone === null
        ? im.space.create(user)
        : im.space.create(user, { phone }));
      await space.send(text);
    };
  })();
  // A failed boot must not poison every later send with the same rejection.
  sdkSender.catch(() => {
    sdkSender = null;
  });
  return sdkSender;
}

function sendViaStub(baseUrl: string, handle: string, text: string, phone: string | null): Promise<void> {
  return fetch(`${baseUrl.replace(/\/+$/, "")}/v1/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, text, phone }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`stub send failed with HTTP ${response.status}`);
  });
}

/**
 * One outbound text through the shared line, chunked when long. `phone` pins
 * the send to a specific dedicated line — pass the line a conversation was
 * received on so replies keep coming from the same number when auto-scale
 * gives the project several. Unpinned sends (OTP, tests) let Spectrum choose.
 */
function sendText(handle: string, text: string, phone?: string): Effect.Effect<void, IMessageError> {
  return Effect.tryPromise({
    try: async () => {
      // Pooled lines report the literal "shared" as their phone; there is
      // nothing to pin to there, so it reads as no preference.
      const requested = phone !== undefined && phone !== "shared" ? phone : undefined;
      const line = requested ?? env("SPECTRUM_LINE_PHONE");
      const stub = spectrumStubBaseUrl();
      const send =
        stub !== null
          ? (h: string, t: string) => sendViaStub(stub, h, t, line)
          : await spectrumSdkSender();
      for (const chunk of splitMessageText(text)) {
        await send(handle, chunk, line);
      }
    },
    catch: (cause) =>
      new IMessageError({
        reason: "spectrum",
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

// --- Deployment side ---------------------------------------------------------

export class IMessagePairing extends Context.Service<IMessagePairing, {
  readonly state: () => Effect.Effect<PairingView, IMessageStoreError>;
  readonly begin: (input: {
    readonly handle: string;
    readonly routerUrl: string;
    readonly deploymentUrl: string;
  }) => Effect.Effect<PairingView, IMessageStoreError>;
  readonly complete: (input: { readonly code: string }) => Effect.Effect<PairingView, IMessageStoreError>;
  readonly unpair: () => Effect.Effect<PairingView, IMessageStoreError>;
  readonly verified: () => Effect.Effect<VerifiedPairing | null, IMessageStoreError>;
  readonly claimInbound: (input: {
    readonly messageId: string;
    readonly spaceId: string;
    readonly handle: string;
  }) => Effect.Effect<boolean, IMessageStoreError>;
  readonly recordInbound: (
    messageId: string,
    result: { readonly status: "ok" | "error"; readonly error?: string },
  ) => Effect.Effect<void, IMessageStoreError>;
  readonly releaseInbound: (messageId: string) => Effect.Effect<void, IMessageStoreError>;
  readonly sendReply: (input: {
    readonly handle: string;
    readonly text: string;
    /** Line the conversation lives on, so the reply comes from the same number. */
    readonly phone?: string;
  }) => Effect.Effect<void, IMessageStoreError>;
}>()("IMessagePairing") {}

export const IMessagePairingLive = Layer.effect(
  IMessagePairing,
  Effect.gen(function* () {
    const database = yield* Db;

    const decodePairingRows = Schema.decodeUnknownEffect(Schema.Array(PairingRow));

    let tablesReady = false;
    const ensureTables = Effect.suspend(() =>
      tablesReady
        ? Effect.void
        : Effect.gen(function* () {
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_pairing (
                 id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                 router_url text NOT NULL,
                 handle text NOT NULL,
                 status text NOT NULL,
                 pairing_id text,
                 secret text,
                 requested_at timestamptz NOT NULL DEFAULT now(),
                 verified_at timestamptz
               )`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_inbound (
                 message_id text PRIMARY KEY,
                 space_id text NOT NULL,
                 handle text NOT NULL,
                 claimed_at timestamptz NOT NULL DEFAULT now(),
                 status text NOT NULL DEFAULT 'claimed',
                 error text
               )`,
            );
            tablesReady = true;
          }),
    );

    const requireDatabase = Effect.suspend(() =>
      hasDatabase() ? Effect.void : Effect.fail(new IMessageError({ reason: "no_database" })),
    );

    const readRow = Effect.gen(function* () {
      yield* ensureTables;
      const rows = yield* database.query(
        `SELECT router_url, handle, status, pairing_id, secret,
                requested_at::text AS requested_at, verified_at::text AS verified_at
           FROM imessage_pairing WHERE id = 1`,
      );
      const decoded = yield* decodePairingRows(rows);
      return decoded.length > 0 ? decoded[0] : null;
    });

    const view = (row: PairingRow | null): PairingView =>
      row === null
        ? { status: "unpaired", handle: null, routerUrl: null, verifiedAt: null }
        : {
            status: row.status,
            handle: row.handle,
            routerUrl: row.router_url,
            verifiedAt: row.verified_at,
          };

    const verified = Effect.gen(function* () {
      if (!hasDatabase()) return null;
      const row = yield* readRow;
      if (row === null || row.status !== "verified" || row.secret === null) return null;
      return { routerUrl: row.router_url, handle: row.handle, secret: row.secret };
    });

    return {
      state: () =>
        Effect.gen(function* () {
          if (!hasDatabase()) return view(null);
          return view(yield* readRow);
        }),

      begin: (input) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          const handle = normalizeHandle(input.handle);
          if (handle === null) {
            return yield* Effect.fail(
              new IMessageError({
                reason: "validation",
                detail: "expected a phone number like +15551234567 or an iMessage email address",
              }),
            );
          }
          const routerUrl = normalizeBaseUrl(input.routerUrl);
          const deploymentUrl = normalizeBaseUrl(input.deploymentUrl);
          if (routerUrl === null || deploymentUrl === null) {
            return yield* Effect.fail(
              new IMessageError({ reason: "validation", detail: "router and deployment URLs must be http(s)" }),
            );
          }

          // Deliberately no cleanup of an existing pairing here: a begin can
          // still fail (rate limit, router down) or never be verified, and
          // the old handle must keep working until the new one is real.
          // Instead, the old secret rides along as proof this deployment owns
          // its current registration, and the router retires exactly that
          // handle inside verifyPair - atomically, and only with that proof.
          const existing = yield* readRow;
          const supersede =
            existing !== null && existing.status === "verified" && existing.secret !== null
              ? { handle: existing.handle, secret: existing.secret }
              : undefined;
          const response = yield* postJson({
            url: `${routerUrl}/api/imessage/pair`,
            json: { handle, deploymentUrl, ...(supersede !== undefined ? { supersede } : {}) },
          });
          const { pairingId } = yield* Schema.decodeUnknownEffect(PairBeginResponse)(response);

          yield* ensureTables;
          yield* database.query(
            `INSERT INTO imessage_pairing (id, router_url, handle, status, pairing_id, secret, requested_at, verified_at)
             VALUES (1, $1, $2, 'pending', $3, NULL, now(), NULL)
             ON CONFLICT (id) DO UPDATE
               SET router_url = EXCLUDED.router_url,
                   handle = EXCLUDED.handle,
                   status = 'pending',
                   pairing_id = EXCLUDED.pairing_id,
                   secret = NULL,
                   requested_at = now(),
                   verified_at = NULL`,
            [routerUrl, handle, pairingId],
          );
          return view(yield* readRow);
        }),

      complete: (input) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          const row = yield* readRow;
          if (row === null || row.status !== "pending" || row.pairing_id === null) {
            return yield* Effect.fail(
              new IMessageError({ reason: "pairing", detail: "no pairing is in progress — start one first" }),
            );
          }
          const code = input.code.trim();
          if (!/^[0-9]{6}$/.test(code)) {
            return yield* Effect.fail(
              new IMessageError({ reason: "validation", detail: "the code is the 6 digits from the text message" }),
            );
          }

          const response = yield* postJson({
            url: `${row.router_url}/api/imessage/pair/verify`,
            json: { pairingId: row.pairing_id, code },
          });
          const confirmed = yield* Schema.decodeUnknownEffect(PairVerifyResponse)(response);

          yield* database.query(
            `UPDATE imessage_pairing
                SET status = 'verified', handle = $1, secret = $2, pairing_id = NULL, verified_at = now()
              WHERE id = 1`,
            [confirmed.handle, confirmed.secret],
          );
          return view(yield* readRow);
        }),

      unpair: () =>
        Effect.gen(function* () {
          yield* requireDatabase;
          const row = yield* readRow;
          if (row !== null && row.status === "verified" && row.secret !== null) {
            // Best effort: losing the race here only leaves a dead registry
            // row on the router, which re-pairing overwrites.
            yield* postJson({
              url: `${row.router_url}/api/imessage/unpair`,
              json: { handle: row.handle },
              bearer: row.secret,
            }).pipe(Effect.ignore);
          }
          yield* database.query(`DELETE FROM imessage_pairing WHERE id = 1`);
          return view(null);
        }),

      verified: () => verified,

      claimInbound: (input) =>
        Effect.gen(function* () {
          yield* requireDatabase;
          yield* ensureTables;
          const rows = yield* database.query(
            `INSERT INTO imessage_inbound (message_id, space_id, handle)
             VALUES ($1, $2, $3)
             ON CONFLICT (message_id) DO NOTHING
             RETURNING message_id`,
            [input.messageId, input.spaceId, input.handle],
          );
          return rows.length > 0;
        }),

      recordInbound: (messageId, result) =>
        Effect.gen(function* () {
          yield* ensureTables;
          yield* database.query(
            `UPDATE imessage_inbound SET status = $2, error = $3 WHERE message_id = $1`,
            [messageId, result.status, result.error ?? null],
          );
        }),

      releaseInbound: (messageId) =>
        Effect.gen(function* () {
          yield* ensureTables;
          yield* database.query(`DELETE FROM imessage_inbound WHERE message_id = $1`, [messageId]);
        }),

      sendReply: (input) =>
        Effect.gen(function* () {
          const pairing = yield* verified;
          if (pairing === null) {
            return yield* Effect.fail(new IMessageError({ reason: "not_paired" }));
          }
          yield* postJson({
            url: `${pairing.routerUrl}/api/imessage/send`,
            json: { handle: input.handle, text: input.text, phone: input.phone ?? null },
            bearer: pairing.secret,
          });
        }),
    };
  }),
);

// --- Router side ---------------------------------------------------------------

export class IMessageRouter extends Context.Service<IMessageRouter, {
  /** The paired deployment for a sender, or null for a stranger. */
  readonly lookup: (
    handle: string,
  ) => Effect.Effect<{ deploymentUrl: string; secret: string } | null, IMessageStoreError>;
  readonly beginPair: (input: {
    readonly handle: string;
    readonly deploymentUrl: string;
    /** The caller's current registration, when this pairing replaces it. */
    readonly supersede?: { readonly handle: string; readonly secret: string };
  }) => Effect.Effect<{ pairingId: string }, IMessageStoreError>;
  readonly verifyPair: (input: {
    readonly pairingId: string;
    readonly code: string;
  }) => Effect.Effect<{ handle: string; secret: string }, IMessageStoreError>;
  /** Send as a paired deployment; the secret must match the handle's row. */
  readonly authorizedSend: (input: {
    readonly handle: string;
    readonly secret: string;
    readonly text: string;
    /** Dedicated line to send from; unset lets Spectrum pick. */
    readonly phone?: string;
  }) => Effect.Effect<void, IMessageStoreError>;
  readonly removeRegistration: (input: {
    readonly handle: string;
    readonly secret: string;
  }) => Effect.Effect<void, IMessageStoreError>;
}>()("IMessageRouter") {}

export const IMessageRouterLive = Layer.effect(
  IMessageRouter,
  Effect.gen(function* () {
    const database = yield* Db;

    const decodeRegistryRows = Schema.decodeUnknownEffect(Schema.Array(RegistryRow));
    const decodePairRequestRows = Schema.decodeUnknownEffect(Schema.Array(PairRequestRow));

    let tablesReady = false;
    const ensureTables = Effect.suspend(() =>
      tablesReady
        ? Effect.void
        : Effect.gen(function* () {
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_registry (
                 handle text PRIMARY KEY,
                 deployment_url text NOT NULL,
                 secret text NOT NULL,
                 verified_at timestamptz NOT NULL DEFAULT now()
               )`,
            );
            yield* database.query(
              `CREATE TABLE IF NOT EXISTS imessage_pair_request (
                 id text PRIMARY KEY,
                 handle text NOT NULL,
                 deployment_url text NOT NULL,
                 code_hash text NOT NULL,
                 attempts integer NOT NULL DEFAULT 0,
                 created_at timestamptz NOT NULL DEFAULT now(),
                 expires_at timestamptz NOT NULL,
                 supersedes_handle text,
                 supersedes_secret text
               )`,
            );
            // Routers created before supersession learn the columns in place.
            yield* database.query(
              `ALTER TABLE imessage_pair_request ADD COLUMN IF NOT EXISTS supersedes_handle text`,
            );
            yield* database.query(
              `ALTER TABLE imessage_pair_request ADD COLUMN IF NOT EXISTS supersedes_secret text`,
            );
            tablesReady = true;
          }),
    );

    const requireRouter = Effect.suspend(() =>
      !imessageRouterConfigured()
        ? Effect.fail(
            new IMessageError({
              reason: "not_configured",
              detail: "this deployment has no SPECTRUM_* credentials, so it is not an iMessage router",
            }),
          )
        : hasDatabase()
          ? Effect.void
          : Effect.fail(new IMessageError({ reason: "no_database" })),
    );

    const authorizedRow = (handle: string, secret: string) =>
      Effect.gen(function* () {
        yield* ensureTables;
        const normalized = normalizeHandle(handle);
        if (normalized === null) {
          return yield* Effect.fail(
            new IMessageError({ reason: "validation", detail: "unrecognized handle" }),
          );
        }
        const rows = yield* database.query(
          `SELECT handle, deployment_url, secret, verified_at::text AS verified_at
             FROM imessage_registry WHERE handle = $1`,
          [normalized],
        );
        const decoded = yield* decodeRegistryRows(rows);
        const row = decoded.length > 0 ? decoded[0] : null;
        if (row === null || !secretsMatch(row.secret, secret)) {
          return yield* Effect.fail(
            new IMessageError({
              reason: "router",
              detail: "that handle is not paired with this secret",
              status: 401,
            }),
          );
        }
        return row;
      });

    return {
      lookup: (handle) =>
        Effect.gen(function* () {
          yield* requireRouter;
          yield* ensureTables;
          const normalized = normalizeHandle(handle) ?? handle;
          const rows = yield* database.query(
            `SELECT handle, deployment_url, secret, verified_at::text AS verified_at
               FROM imessage_registry WHERE handle = $1`,
            [normalized],
          );
          const decoded = yield* decodeRegistryRows(rows);
          if (decoded.length === 0) return null;
          return { deploymentUrl: decoded[0].deployment_url, secret: decoded[0].secret };
        }),

      beginPair: (input) =>
        Effect.gen(function* () {
          yield* requireRouter;
          yield* ensureTables;
          const handle = normalizeHandle(input.handle);
          const deploymentUrl = input.deploymentUrl.length > 0 ? normalizeBaseUrl(input.deploymentUrl) : null;
          if (handle === null || deploymentUrl === null) {
            return yield* Effect.fail(
              new IMessageError({
                reason: "validation",
                detail: "pairing needs a valid handle and an http(s) deployment URL",
              }),
            );
          }

          // Old rows age out after a day, not at OTP expiry: an expired or
          // burned request still counts as a text the line sent, and deleting
          // it early would quietly turn the hourly cap into a 10-minute one.
          yield* database.query(
            `DELETE FROM imessage_pair_request WHERE created_at < now() - interval '24 hours'`,
          );
          const recent = yield* database.query(
            `SELECT (count(*) FILTER (WHERE handle = $1))::int AS for_handle,
                    count(*)::int AS total
               FROM imessage_pair_request
              WHERE created_at > now() - interval '1 hour'`,
            [handle],
          );
          const counts = (recent[0] ?? {}) as { for_handle?: number; total?: number };
          if (Number(counts.for_handle ?? 0) >= MAX_PAIR_REQUESTS_PER_HOUR) {
            return yield* Effect.fail(
              new IMessageError({
                reason: "pairing",
                detail: "too many pairing texts to that number in the last hour — try again later",
                status: 429,
              }),
            );
          }
          if (Number(counts.total ?? 0) >= MAX_PAIR_REQUESTS_PER_HOUR_TOTAL) {
            return yield* Effect.fail(
              new IMessageError({
                reason: "pairing",
                detail: "the shared line is rate-limited on pairing texts right now — try again later",
                status: 429,
              }),
            );
          }

          // A supersession claim only sticks with proof: the old handle's own
          // secret. The OTP authenticates the NEW handle and nothing else, so
          // an unproven claim (or none) must never touch existing rows —
          // otherwise anyone could evict a stranger's registration by pairing
          // their own phone against the stranger's deployment URL.
          let supersedesHandle: string | null = null;
          let supersedesSecret: string | null = null;
          if (input.supersede !== undefined) {
            const claimed = normalizeHandle(input.supersede.handle);
            if (claimed !== null) {
              const held = yield* database.query(
                `SELECT secret FROM imessage_registry WHERE handle = $1`,
                [claimed],
              );
              const secret = (held[0] as { secret?: string } | undefined)?.secret;
              if (secret !== undefined && secretsMatch(secret, input.supersede.secret)) {
                supersedesHandle = claimed;
                supersedesSecret = secret;
              }
            }
          }

          const pairingId = randomUUID();
          const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
          yield* database.query(
            `INSERT INTO imessage_pair_request (id, handle, deployment_url, code_hash, expires_at, supersedes_handle, supersedes_secret)
             VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7)`,
            [
              pairingId,
              handle,
              deploymentUrl,
              sha256Hex(code),
              Date.now() + PAIR_REQUEST_TTL_MS,
              supersedesHandle,
              supersedesSecret,
            ],
          );

          // The one cold send in the whole flow — everything after this is a
          // reply within an existing conversation.
          yield* sendText(
            handle,
            `Ruth here. Your pairing code is ${code}. It expires in 10 minutes. If you didn't ask to pair this number, ignore this text.`,
          ).pipe(
            Effect.tapError(() =>
              database
                .query(`DELETE FROM imessage_pair_request WHERE id = $1`, [pairingId])
                .pipe(Effect.ignore),
            ),
          );

          return { pairingId };
        }),

      verifyPair: (input) =>
        Effect.gen(function* () {
          yield* requireRouter;
          yield* ensureTables;
          const rows = yield* database.query(
            `SELECT id, handle, deployment_url, code_hash, attempts,
                    (extract(epoch FROM expires_at) * 1000)::float8 AS expires_at_ms,
                    supersedes_handle, supersedes_secret
               FROM imessage_pair_request WHERE id = $1`,
            [input.pairingId],
          );
          const decoded = yield* decodePairRequestRows(rows);
          const request = decoded.length > 0 ? decoded[0] : null;
          const refused = (detail: string) =>
            Effect.fail(new IMessageError({ reason: "pairing", detail, status: 400 }));

          if (request === null) {
            return yield* refused("that pairing is unknown or already used — start again");
          }
          if (request.expires_at_ms < Date.now()) {
            yield* database.query(`DELETE FROM imessage_pair_request WHERE id = $1`, [request.id]);
            return yield* refused("that code expired — start pairing again");
          }
          if (request.attempts >= MAX_VERIFY_ATTEMPTS) {
            yield* database.query(`DELETE FROM imessage_pair_request WHERE id = $1`, [request.id]);
            return yield* refused("too many wrong guesses — start pairing again");
          }
          if (!hashesMatch(request.code_hash, input.code.trim())) {
            yield* database.query(
              `UPDATE imessage_pair_request SET attempts = attempts + 1 WHERE id = $1`,
              [request.id],
            );
            return yield* refused("that code does not match");
          }

          // Receiving the OTP at the handle is ownership; a re-pair simply
          // moves the handle to its new deployment.
          const secret = randomBytes(32).toString("hex");
          yield* database.query(
            `INSERT INTO imessage_registry (handle, deployment_url, secret)
             VALUES ($1, $2, $3)
             ON CONFLICT (handle) DO UPDATE
               SET deployment_url = EXCLUDED.deployment_url,
                   secret = EXCLUDED.secret,
                   verified_at = now()`,
            [request.handle, request.deployment_url, secret],
          );
          // Retire the handle this pairing replaces — atomically with the new
          // registration, matching the exact secret proven at begin. Matching
          // the secret (not the caller-supplied URL) is what makes this safe:
          // if that handle was re-paired to another deployment after this
          // request started, its registry secret has rotated, so this delete
          // finds nothing and leaves the newer registration intact. A row
          // still holding the proven secret is the one we authenticated.
          if (
            request.supersedes_handle !== null &&
            request.supersedes_secret !== null &&
            request.supersedes_handle !== request.handle
          ) {
            yield* database.query(
              `DELETE FROM imessage_registry WHERE handle = $1 AND secret = $2`,
              [request.supersedes_handle, request.supersedes_secret],
            );
          }
          yield* database.query(`DELETE FROM imessage_pair_request WHERE id = $1`, [request.id]);
          return { handle: request.handle, secret };
        }),

      authorizedSend: (input) =>
        Effect.gen(function* () {
          yield* requireRouter;
          const row = yield* authorizedRow(input.handle, input.secret);
          const text = input.text.trim();
          if (text.length === 0) {
            return yield* Effect.fail(
              new IMessageError({ reason: "validation", detail: "nothing to send" }),
            );
          }
          yield* sendText(row.handle, text, input.phone);
        }),

      removeRegistration: (input) =>
        Effect.gen(function* () {
          yield* requireRouter;
          const row = yield* authorizedRow(input.handle, input.secret);
          yield* database.query(`DELETE FROM imessage_registry WHERE handle = $1`, [row.handle]);
        }),
    };
  }),
);

// --- Accessors -----------------------------------------------------------------

export const imessagePairingState = (): Effect.Effect<
  PairingView,
  IMessageStoreError,
  IMessagePairing
> =>
  Effect.gen(function* () {
    return yield* (yield* IMessagePairing).state();
  });

export const beginIMessagePairing = (input: {
  readonly handle: string;
  readonly routerUrl: string;
  readonly deploymentUrl: string;
}): Effect.Effect<PairingView, IMessageStoreError, IMessagePairing> =>
  Effect.gen(function* () {
    return yield* (yield* IMessagePairing).begin(input);
  });

export const completeIMessagePairing = (input: {
  readonly code: string;
}): Effect.Effect<PairingView, IMessageStoreError, IMessagePairing> =>
  Effect.gen(function* () {
    return yield* (yield* IMessagePairing).complete(input);
  });

export const unpairIMessage = (): Effect.Effect<PairingView, IMessageStoreError, IMessagePairing> =>
  Effect.gen(function* () {
    return yield* (yield* IMessagePairing).unpair();
  });

export const verifiedIMessagePairing = (): Effect.Effect<
  VerifiedPairing | null,
  IMessageStoreError,
  IMessagePairing
> =>
  Effect.gen(function* () {
    return yield* (yield* IMessagePairing).verified();
  });

export const claimIMessageInbound = (input: {
  readonly messageId: string;
  readonly spaceId: string;
  readonly handle: string;
}): Effect.Effect<boolean, IMessageStoreError, IMessagePairing> =>
  Effect.gen(function* () {
    return yield* (yield* IMessagePairing).claimInbound(input);
  });

export const recordIMessageInbound = (
  messageId: string,
  result: { readonly status: "ok" | "error"; readonly error?: string },
): Effect.Effect<void, IMessageStoreError, IMessagePairing> =>
  Effect.gen(function* () {
    return yield* (yield* IMessagePairing).recordInbound(messageId, result);
  });

export const releaseIMessageInbound = (
  messageId: string,
): Effect.Effect<void, IMessageStoreError, IMessagePairing> =>
  Effect.gen(function* () {
    return yield* (yield* IMessagePairing).releaseInbound(messageId);
  });

export const sendIMessageReply = (input: {
  readonly handle: string;
  readonly text: string;
  readonly phone?: string;
}): Effect.Effect<void, IMessageStoreError, IMessagePairing> =>
  Effect.gen(function* () {
    return yield* (yield* IMessagePairing).sendReply(input);
  });

export const lookupIMessageRegistration = (
  handle: string,
): Effect.Effect<
  { deploymentUrl: string; secret: string } | null,
  IMessageStoreError,
  IMessageRouter
> =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRouter).lookup(handle);
  });

export const beginIMessagePairRequest = (input: {
  readonly handle: string;
  readonly deploymentUrl: string;
}): Effect.Effect<{ pairingId: string }, IMessageStoreError, IMessageRouter> =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRouter).beginPair(input);
  });

export const verifyIMessagePairRequest = (input: {
  readonly pairingId: string;
  readonly code: string;
}): Effect.Effect<{ handle: string; secret: string }, IMessageStoreError, IMessageRouter> =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRouter).verifyPair(input);
  });

export const sendIMessageAsDeployment = (input: {
  readonly handle: string;
  readonly secret: string;
  readonly text: string;
  readonly phone?: string;
}): Effect.Effect<void, IMessageStoreError, IMessageRouter> =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRouter).authorizedSend(input);
  });

export const removeIMessageRegistration = (input: {
  readonly handle: string;
  readonly secret: string;
}): Effect.Effect<void, IMessageStoreError, IMessageRouter> =>
  Effect.gen(function* () {
    return yield* (yield* IMessageRouter).removeRegistration(input);
  });
