import { Context, Data, Effect, Layer, Schema, Semaphore } from "effect";
import type { SchemaError } from "effect/SchemaError";

import { type DatabaseError, Db } from "./db";

// Agentcard (https://agentcard.sh) gives the agent a virtual Visa it can
// spend: prepaid cards with a fixed limit. The capability arrives as an MCP
// server, wired up in agent/connections/agentcard.ts, and either of two
// account shapes can back it:
//
// - **Personal** (agentcard-personal.ts): the owner's own Agentcard account,
//   connected once in the browser via OAuth 2.1 + PKCE with a dynamically
//   registered client (RFC 7591). The default when no company credentials
//   are configured.
// - **Company** (agentcard-company.ts): this deployment holds company client
//   credentials (AGENTCARD_CLIENT_ID / AGENTCARD_CLIENT_SECRET) and the
//   owner is its single connected user; connecting is a one-time code
//   emailed to AGENTCARD_OWNER_EMAIL — no browser required, which is the
//   shape that works from iMessage, Slack, and Telegram.
//
// Either way the credential is app-scoped on purpose: eve's interactive
// authorization strategies are pinned to `principalType: "user"`, and this
// app's eve channel admits anonymous callers (agent/channels/eve.ts uses
// none()), so a user-scoped grant could never resolve — schedules, inbound
// email, and Telegram all run without an end-user principal. One stored
// grant backs every surface.
//
// This module is the part both flows share: the error type, the stored-grant
// schema (tagged with the mode that wrote it), the storage service over the
// agentcard_oauth table, and the grant machinery — status, single-flight
// refresh, and the rotation-race handling. The mode-specific connect flows
// live in their own modules; runtime.ts picks the live layer from env.

const DEFAULT_MCP_URL = "https://mcp.agentcard.sh/mcp";
const DEFAULT_API_URL = "https://api.agentcard.sh";

/** Where the owner manages cards, funding, and plan outside the agent. */
export const AGENTCARD_DASHBOARD_URL = "https://app.agentcard.sh";

const HTTP_TIMEOUT = "20 seconds";

/** Refresh this far ahead of expiry so a token never dies mid-tool-call. */
export const REFRESH_MARGIN_MS = 120_000;

/** An unfinished authorization is abandoned after this long. */
export const PENDING_TTL_MS = 15 * 60_000;

/**
 * Assumed access-token lifetime when the server omits `expires_in`. Short
 * enough that a silently-rotated grant self-heals on the next call.
 */
export const ASSUMED_TOKEN_TTL_MS = 30 * 60_000;

export const CLIENT_ROW = "client";
export const TOKENS_ROW = "tokens";
export const PENDING_ROW = "pending";
export const COMPANY_PENDING_ROW = "company_pending";

export type AgentcardMode = "personal" | "company";

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
    | "wrong_mode";
  readonly detail?: string;
  /** HTTP status behind a `provider` failure; absent when nothing answered. */
  readonly status?: number;
}> {}

export function describeAgentcardError(error: AgentcardError): string {
  const reconnect = companyModeEnabled()
    ? "Ask the owner to reconnect: he can say 'connect my card' here in chat (a one-time code goes to his email), or use Manage -> Card."
    : "Ask the owner to reconnect it under Manage -> Card in the app; it takes one sign-in in the browser.";
  switch (error.reason) {
    case "not_connected":
      return `Agentcard is not connected yet, so there is no card to spend from. ${reconnect} Do not ask him for a card number, and do not try to pay any other way.`;
    case "reauthorize":
      return `The Agentcard connection expired or was revoked. ${reconnect}`;
    case "no_database":
      return "Agentcard needs DATABASE_URL to store its connection, and this deployment has no database configured.";
    case "not_configured":
      return `Agentcard company mode is missing configuration: ${error.detail ?? "a required environment variable is unset"}.`;
    case "wrong_mode":
      return error.detail ?? "That connect flow does not apply to this deployment's Agentcard mode.";
    case "authorization_state":
      return `That Agentcard sign-in could not be completed: ${error.detail ?? "the authorization state did not match"}. Start the connection again.`;
    case "provider":
      return `Agentcard rejected the request: ${error.detail ?? "unknown error"}`;
  }
}

export type AgentcardStoreError = AgentcardError | DatabaseError | SchemaError;

// --- Stored rows -----------------------------------------------------------

/**
 * The one grant this deployment spends with, whichever flow established it.
 * The mode tag keeps a grant from ever being sent to the other mode's
 * endpoints: a mismatch reads as "not connected" and the owner reconnects
 * once. Rows written before the tag existed decode as personal.
 */
export const StoredTokens = Schema.Struct({
  mode: Schema.Literals(["personal", "company"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("personal" as const)),
  ),
  /** Personal: the dynamically-registered client the grant was issued to. */
  client_id: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  client_secret: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  access_token: Schema.String,
  refresh_token: Schema.NullOr(Schema.String),
  /** Epoch ms, or null when the server never said. */
  expires_at: Schema.NullOr(Schema.Finite),
  connected_at: Schema.Finite,
  /** Company: the connected user, for status display and consent audit. */
  user_id: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  email: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});
export type StoredTokens = typeof StoredTokens.Type;

export interface AgentcardStatus {
  readonly connected: boolean;
  /** ISO timestamp of the last successful authorization. */
  readonly connectedAt: string | null;
  /** False when there is no database to hold the grant at all. */
  readonly canConnect: boolean;
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

/** The company REST API base; the stub serves this surface too. */
export function agentcardApiUrl(): string {
  const configured = process.env.AGENTCARD_API_URL?.trim();
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_API_URL;
}

/** Company credentials present means the company flow runs this deployment. */
export function companyModeEnabled(): boolean {
  const id = process.env.AGENTCARD_CLIENT_ID?.trim() ?? "";
  const secret = process.env.AGENTCARD_CLIENT_SECRET?.trim() ?? "";
  return id.length > 0 && secret.length > 0;
}

/**
 * Where company-mode connect codes are sent. Env-pinned so neither the model
 * nor a request body ever chooses the address a credential-granting code
 * lands in.
 */
export function agentcardOwnerEmail(): string | null {
  const configured = process.env.AGENTCARD_OWNER_EMAIL?.trim();
  return configured !== undefined && configured.length > 0 ? configured : null;
}

function hasDatabase(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

// --- HTTP ------------------------------------------------------------------

export interface RequestOptions {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly form?: Record<string, string>;
  readonly json?: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * One JSON request against an Agentcard endpoint. Retried only for transport
 * failures and 5xx: a 4xx is a decision (bad code, revoked grant) that
 * repeating cannot change.
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
        throw new HttpFailure(response.status, providerMessage(text) ?? `HTTP ${response.status}`);
      }
      return text.length === 0 ? null : (JSON.parse(text) as unknown);
    },
    catch: (cause) =>
      cause instanceof HttpFailure
        ? new AgentcardError({
            reason: "provider",
            detail: cause.message,
            status: cause.status,
          })
        : new AgentcardError({
            reason: "provider",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
  });

  return attempt.pipe(
    Effect.retry({
      times: 2,
      // A refused authorization must surface as-is; only transport and server
      // faults are worth repeating.
      while: (error: AgentcardError) => isRetryable(error),
    }),
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

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpFailure";
    this.status = status;
  }
}

function isRetryable(error: AgentcardError): boolean {
  // No status means nothing answered (DNS, connection reset), which is worth
  // another go. A 4xx is a decision repeating cannot change.
  return error.status === undefined || error.status >= 500;
}

/** OAuth errors are `{error, error_description}`; fall back to raw text. */
function providerMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const { error, error_description: description } = parsed as {
        error?: unknown;
        error_description?: unknown;
      };
      const code = typeof error === "string" ? error : null;
      const detail = typeof description === "string" ? description : null;
      if (code !== null) return detail === null ? code : `${code}: ${detail}`;
      if (detail !== null) return detail;
    }
  } catch {
    // Not JSON.
  }
  const trimmed = body.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 300);
}

/** True when the provider says the grant itself is gone, not merely stale. */
export function isGrantRejection(error: AgentcardError): boolean {
  return /invalid_grant|invalid_client|unauthorized_client|invalid_refresh_token/.test(
    error.detail ?? "",
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
const STORE_FIELDS = new Set(["state", "access_token", "connect_id"]);

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
          yield* database.query(
            `INSERT INTO agentcard_oauth (name, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [name, JSON.stringify(value)],
          );
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

/**
 * How a grant gets established, which is the only thing the two modes do
 * differently. Narrow on `mode` before calling; the accessors below do and
 * fail `wrong_mode` otherwise, so routes and tools share one answer.
 */
export type AgentcardFlow =
  | {
      readonly mode: "personal";
      /** Authorize URL for the owner's browser; stores the PKCE state to match. */
      readonly beginAuthorization: (
        redirectUri: string,
      ) => Effect.Effect<{ url: string }, AgentcardStoreError>;
      readonly completeAuthorization: (params: {
        readonly state: string;
        readonly code: string;
      }) => Effect.Effect<void, AgentcardStoreError>;
    }
  | {
      readonly mode: "company";
      /** Email a one-time code to the env-pinned owner address. */
      readonly startConnect: () => Effect.Effect<
        { expiresAt: string | null },
        AgentcardStoreError
      >;
      readonly verifyConnect: (code: string) => Effect.Effect<void, AgentcardStoreError>;
    };

export class Agentcard extends Context.Service<Agentcard, {
  readonly status: () => Effect.Effect<AgentcardStatus, AgentcardStoreError>;
  /** A live bearer for the MCP server, refreshed when it is close to expiry. */
  readonly accessToken: () => Effect.Effect<
    { token: string; expiresAt: number | null },
    AgentcardStoreError
  >;
  readonly disconnect: () => Effect.Effect<void, AgentcardStoreError>;
  readonly flow: AgentcardFlow;
}>()("Agentcard") {}

// --- Grant machinery -------------------------------------------------------

/** What `makeGrantMachinery` hands a flow layer to build on. */
export interface GrantMachinery {
  /** The stored grant, or null when absent or written by the other mode. */
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
   * refresh behind the gate with the mode's own exchange. A caller that
   * queued behind an in-flight refresh finds the fresh grant already stored
   * and skips its own exchange entirely.
   */
  readonly accessTokenVia: (
    refresh: (tokens: StoredTokens) => Effect.Effect<StoredTokens, AgentcardStoreError>,
  ) => Effect.Effect<{ token: string; expiresAt: number | null }, AgentcardStoreError>;
}

export const makeGrantMachinery = (
  mode: AgentcardMode,
): Effect.Effect<GrantMachinery, never, AgentcardStore> =>
  Effect.gen(function* () {
    const store = yield* AgentcardStore;
    // One refresh at a time in this process. Refresh tokens rotate on use,
    // so two callers redeeming the same one produces a winner and an
    // invalid-grant loser; serializing lets the second caller reuse the
    // first one's result instead of racing it.
    const refreshGate = yield* Semaphore.make(1);
    const decodeStoredTokens = Schema.decodeUnknownEffect(StoredTokens);

    const currentTokens = (): Effect.Effect<StoredTokens | null, AgentcardStoreError> =>
      Effect.gen(function* () {
        const stored = yield* store.read(TOKENS_ROW);
        if (stored === null) return null;
        const tokens = yield* decodeStoredTokens(stored);
        // A grant from the other mode must never reach this mode's
        // endpoints: it reads as "not connected", and the owner reconnects
        // once after flipping env.
        return tokens.mode === mode ? tokens : null;
      });

    const storeTokens = (tokens: StoredTokens): Effect.Effect<void, AgentcardStoreError> =>
      store.write(TOKENS_ROW, tokens);

    /** Usable as-is, with enough margin left that a tool call won't outlive it. */
    const isFresh = (tokens: StoredTokens): boolean =>
      tokens.expires_at === null || tokens.expires_at - REFRESH_MARGIN_MS > Date.now();

    const resolveRejectedGrant = (
      rejected: StoredTokens,
    ): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        yield* store.removeMatching(TOKENS_ROW, "access_token", rejected.access_token);
        const current = yield* currentTokens();
        if (current !== null && current.access_token !== rejected.access_token) {
          return current;
        }
        return yield* Effect.fail(new AgentcardError({ reason: "reauthorize" }));
      });

    const status = (): Effect.Effect<AgentcardStatus, AgentcardStoreError> =>
      Effect.gen(function* () {
        if (!store.available()) {
          return { connected: false, connectedAt: null, canConnect: false };
        }
        const tokens = yield* currentTokens();
        return {
          connected: tokens !== null,
          connectedAt: tokens === null ? null : new Date(tokens.connected_at).toISOString(),
          canConnect: true,
        };
      });

    // Clears every row, so Disconnect -> Connect is a full reset in either
    // mode: the owner's way out of any stale state without reaching into the
    // database. The other mode's leftovers are harmless to clear too.
    const disconnect = (): Effect.Effect<void, AgentcardStoreError> =>
      Effect.gen(function* () {
        yield* store.remove(TOKENS_ROW);
        yield* store.remove(PENDING_ROW);
        yield* store.remove(COMPANY_PENDING_ROW);
        yield* store.remove(CLIENT_ROW);
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

    return { currentTokens, storeTokens, resolveRejectedGrant, status, disconnect, accessTokenVia };
  });

// --- Accessors -------------------------------------------------------------

// Build programs against the service without resolving it, so call sites
// stay one-liners and tests can swap the layer. The flow accessors narrow
// the mode and fail `wrong_mode` otherwise — routes and tools inherit one
// consistent answer for "this deployment doesn't work that way".

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

export const disconnectAgentcard = (): Effect.Effect<void, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).disconnect();
  });

export const beginAgentcardAuthorization = (
  redirectUri: string,
): Effect.Effect<{ url: string }, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    const { flow } = yield* Agentcard;
    if (flow.mode !== "personal") {
      return yield* Effect.fail(
        new AgentcardError({
          reason: "wrong_mode",
          detail:
            "This deployment runs Agentcard company mode; connect with an emailed code from Manage -> Card instead of a browser sign-in.",
        }),
      );
    }
    return yield* flow.beginAuthorization(redirectUri);
  });

export const completeAgentcardAuthorization = (params: {
  readonly state: string;
  readonly code: string;
}): Effect.Effect<void, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    const { flow } = yield* Agentcard;
    if (flow.mode !== "personal") {
      return yield* Effect.fail(
        new AgentcardError({
          reason: "wrong_mode",
          detail:
            "This deployment runs Agentcard company mode; connect with an emailed code from Manage -> Card instead of a browser sign-in.",
        }),
      );
    }
    return yield* flow.completeAuthorization(params);
  });

export const startCompanyConnect = (): Effect.Effect<
  { expiresAt: string | null },
  AgentcardStoreError,
  Agentcard
> =>
  Effect.gen(function* () {
    const { flow } = yield* Agentcard;
    if (flow.mode !== "company") {
      return yield* Effect.fail(
        new AgentcardError({
          reason: "wrong_mode",
          detail:
            "This deployment runs Agentcard in personal mode; connect from Manage -> Card with the browser sign-in.",
        }),
      );
    }
    return yield* flow.startConnect();
  });

export const verifyCompanyConnect = (
  code: string,
): Effect.Effect<void, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    const { flow } = yield* Agentcard;
    if (flow.mode !== "company") {
      return yield* Effect.fail(
        new AgentcardError({
          reason: "wrong_mode",
          detail:
            "This deployment runs Agentcard in personal mode; connect from Manage -> Card with the browser sign-in.",
        }),
      );
    }
    return yield* flow.verifyConnect(code);
  });
