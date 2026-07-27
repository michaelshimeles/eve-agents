import { createHash, randomBytes } from "node:crypto";

import { Context, Data, Effect, Layer, Schema, Semaphore } from "effect";
import type { SchemaError } from "effect/SchemaError";

import { type DatabaseError, Db } from "./db";

// Agentcard (https://agentcard.sh) gives the agent a virtual Visa it can spend:
// prepaid cards with a fixed limit, drawn from the owner's cash balance or
// minted against a card he attached. The capability arrives as an MCP server,
// wired up in agent/connections/agentcard.ts.
//
// That server speaks OAuth 2.1 only — no API keys — which is the whole reason
// this module exists. eve's interactive-authorization strategies are pinned to
// `principalType: "user"`, and this app's eve channel admits anonymous callers
// (agent/channels/eve.ts uses none()), so a user-scoped grant could never
// resolve: schedules, inbound email, and Telegram all run without an end-user
// principal. Instead the owner completes the OAuth flow once in the browser
// (Manage -> Card, via app/api/agentcard/*), the grant is stored here, and the
// connection reads it as one app-scoped credential that works on every surface.
//
// Everything the flow needs is discovered from the server's own metadata
// documents, and the client is registered dynamically (RFC 7591), so there is
// no client id to configure by hand.

const DEFAULT_MCP_URL = "https://mcp.agentcard.sh/mcp";

/** Where the owner manages cards, funding, and plan outside the agent. */
export const AGENTCARD_DASHBOARD_URL = "https://app.agentcard.sh";

const HTTP_TIMEOUT = "20 seconds";

/** Refresh this far ahead of expiry so a token never dies mid-tool-call. */
const REFRESH_MARGIN_MS = 120_000;

/** An unfinished authorization is abandoned after this long. */
const PENDING_TTL_MS = 15 * 60_000;

/**
 * Assumed access-token lifetime when the server omits `expires_in`. Short
 * enough that a silently-rotated grant self-heals on the next call.
 */
const ASSUMED_TOKEN_TTL_MS = 30 * 60_000;

const CLIENT_ROW = "client";
const TOKENS_ROW = "tokens";
const PENDING_ROW = "pending";

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
    | "authorization_state";
  readonly detail?: string;
  /** HTTP status behind a `provider` failure; absent when nothing answered. */
  readonly status?: number;
}> {}

export function describeAgentcardError(error: AgentcardError): string {
  switch (error.reason) {
    case "not_connected":
      return "Agentcard is not connected yet, so there is no card to spend from. Ask the owner to open Manage -> Card in the app and connect his Agentcard account; it takes one sign-in in the browser.";
    case "reauthorize":
      return "The Agentcard connection expired or was revoked. Ask the owner to reconnect it under Manage -> Card.";
    case "no_database":
      return "Agentcard needs DATABASE_URL to store its connection, and this deployment has no database configured.";
    case "authorization_state":
      return `That Agentcard sign-in could not be completed: ${error.detail ?? "the authorization state did not match"}. Start the connection again from Manage -> Card.`;
    case "provider":
      return `Agentcard rejected the request: ${error.detail ?? "unknown error"}`;
  }
}

export type AgentcardStoreError = AgentcardError | DatabaseError | SchemaError;

// --- Provider payloads -----------------------------------------------------

/** The subset of RFC 8414 metadata this flow drives. */
const ServerMetadata = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optionalKey(Schema.String),
});
type ServerMetadata = typeof ServerMetadata.Type;

const RegistrationResponse = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optionalKey(Schema.String),
});

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Finite),
});

// --- Stored rows -----------------------------------------------------------

const StoredClient = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.NullOr(Schema.String),
  /** Registered redirect URI; a different app origin needs its own client. */
  redirect_uri: Schema.String,
});
type StoredClient = typeof StoredClient.Type;

const StoredTokens = Schema.Struct({
  /** The client the grant was issued to — refreshing requires the same one. */
  client_id: Schema.String,
  client_secret: Schema.NullOr(Schema.String),
  access_token: Schema.String,
  refresh_token: Schema.NullOr(Schema.String),
  /** Epoch ms, or null when the server never said. */
  expires_at: Schema.NullOr(Schema.Finite),
  connected_at: Schema.Finite,
});
type StoredTokens = typeof StoredTokens.Type;

const PendingAuthorization = Schema.Struct({
  state: Schema.String,
  verifier: Schema.String,
  redirect_uri: Schema.String,
  client_id: Schema.String,
  client_secret: Schema.NullOr(Schema.String),
  started_at: Schema.Finite,
});

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

function hasDatabase(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

// --- HTTP ------------------------------------------------------------------

interface RequestOptions {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly form?: Record<string, string>;
  readonly json?: unknown;
}

/**
 * One JSON request against the authorization server. Retried only for
 * transport failures and 5xx: a 4xx is a decision (bad code, revoked grant)
 * that repeating cannot change.
 */
function requestJson(options: RequestOptions): Effect.Effect<unknown, AgentcardError> {
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
function isGrantRejection(error: AgentcardError): boolean {
  return /invalid_grant|invalid_client|unauthorized_client/.test(error.detail ?? "");
}

// --- Service ---------------------------------------------------------------

export class Agentcard extends Context.Service<Agentcard, {
  readonly status: () => Effect.Effect<AgentcardStatus, AgentcardStoreError>;
  /** Authorize URL for the owner's browser; stores the PKCE state to match. */
  readonly beginAuthorization: (
    redirectUri: string,
  ) => Effect.Effect<{ url: string }, AgentcardStoreError>;
  readonly completeAuthorization: (params: {
    readonly state: string;
    readonly code: string;
  }) => Effect.Effect<void, AgentcardStoreError>;
  /** A live bearer for the MCP server, refreshed when it is close to expiry. */
  readonly accessToken: () => Effect.Effect<
    { token: string; expiresAt: number | null },
    AgentcardStoreError
  >;
  readonly disconnect: () => Effect.Effect<void, AgentcardStoreError>;
}>()("Agentcard") {}

export const AgentcardLive = Layer.effect(
  Agentcard,
  Effect.gen(function* () {
    const database = yield* Db;

    // One refresh at a time in this process. The service's refresh tokens
    // rotate on use, so two callers redeeming the same one produces a winner
    // and an invalid_grant loser; serializing lets the second caller reuse
    // the first one's result instead of racing it.
    const refreshGate = yield* Semaphore.make(1);

    const decodeMetadata = Schema.decodeUnknownEffect(ServerMetadata);
    const decodeRegistration = Schema.decodeUnknownEffect(RegistrationResponse);
    const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
    const decodeStoredClient = Schema.decodeUnknownEffect(StoredClient);
    const decodeStoredTokens = Schema.decodeUnknownEffect(StoredTokens);
    const decodePending = Schema.decodeUnknownEffect(PendingAuthorization);

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

    const readRow = (
      name: string,
    ): Effect.Effect<unknown | null, DatabaseError | AgentcardError> =>
      Effect.gen(function* () {
        yield* requireDatabase;
        yield* ensureTable;
        const rows = yield* database.query(
          "SELECT value FROM agentcard_oauth WHERE name = $1",
          [name],
        );
        const row = rows[0] as { value?: unknown } | undefined;
        return row?.value ?? null;
      });

    const writeRow = (
      name: string,
      value: unknown,
    ): Effect.Effect<void, DatabaseError | AgentcardError> =>
      Effect.gen(function* () {
        yield* requireDatabase;
        yield* ensureTable;
        yield* database.query(
          `INSERT INTO agentcard_oauth (name, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [name, JSON.stringify(value)],
        );
      });

    const deleteRow = (name: string): Effect.Effect<void, DatabaseError | AgentcardError> =>
      Effect.gen(function* () {
        yield* requireDatabase;
        yield* ensureTable;
        yield* database.query("DELETE FROM agentcard_oauth WHERE name = $1", [name]);
      });

    /**
     * Drop the stored grant only while it still holds `accessToken`. The
     * predicate runs inside the DELETE, so a grant that a concurrent refresh
     * (possibly in another instance) already replaced is left alone.
     */
    const dropGrantIfUnchanged = (
      accessToken: string,
    ): Effect.Effect<void, DatabaseError | AgentcardError> =>
      Effect.gen(function* () {
        yield* requireDatabase;
        yield* ensureTable;
        yield* database.query(
          `DELETE FROM agentcard_oauth WHERE name = $1 AND value->>'access_token' = $2`,
          [TOKENS_ROW, accessToken],
        );
      });

    /**
     * Consume the pending authorization, but only when its state matches the
     * one the callback carried — one atomic statement, so a stale callback
     * from a superseded sign-in cannot eat the attempt that replaced it.
     */
    const takePending = (
      state: string,
    ): Effect.Effect<unknown | null, DatabaseError | AgentcardError> =>
      Effect.gen(function* () {
        yield* requireDatabase;
        yield* ensureTable;
        const rows = yield* database.query(
          `DELETE FROM agentcard_oauth WHERE name = $1 AND value->>'state' = $2 RETURNING value`,
          [PENDING_ROW, state],
        );
        const row = rows[0] as { value?: unknown } | undefined;
        return row?.value ?? null;
      });

    // Metadata is immutable for the life of the process; one fetch covers
    // every authorization and refresh.
    let metadata: ServerMetadata | undefined;
    const serverMetadata = Effect.suspend(() =>
      metadata !== undefined
        ? Effect.succeed(metadata)
        : Effect.gen(function* () {
            const origin = new URL(agentcardMcpUrl()).origin;
            const payload = yield* requestJson({
              url: `${origin}/.well-known/oauth-authorization-server`,
            });
            const resolved = yield* decodeMetadata(payload);
            metadata = resolved;
            return resolved;
          }),
    );

    /**
     * The dynamically-registered client for this app origin. Re-registers when
     * the redirect URI changes (localhost in dev, the deployment host in
     * production) because an authorization server only honours URIs it holds.
     */
    const clientFor = (
      redirectUri: string,
    ): Effect.Effect<StoredClient, AgentcardStoreError> =>
      Effect.gen(function* () {
        const stored = yield* readRow(CLIENT_ROW);
        if (stored !== null) {
          const client = yield* decodeStoredClient(stored);
          if (client.redirect_uri === redirectUri) return client;
        }

        const { registration_endpoint: endpoint } = yield* serverMetadata;
        if (endpoint === undefined) {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "provider",
              detail: "the server does not support dynamic client registration",
            }),
          );
        }

        const payload = yield* requestJson({
          url: endpoint,
          method: "POST",
          json: {
            client_name: "eveclaw",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
        });
        const registered = yield* decodeRegistration(payload);
        const client: StoredClient = {
          client_id: registered.client_id,
          client_secret: registered.client_secret ?? null,
          redirect_uri: redirectUri,
        };
        yield* writeRow(CLIENT_ROW, client);
        return client;
      });

    const storeTokens = (
      client: Pick<StoredClient, "client_id" | "client_secret">,
      response: typeof TokenResponse.Type,
      connectedAt: number,
    ): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        const lifetimeMs =
          response.expires_in === undefined ? ASSUMED_TOKEN_TTL_MS : response.expires_in * 1000;
        const tokens: StoredTokens = {
          client_id: client.client_id,
          client_secret: client.client_secret,
          access_token: response.access_token,
          refresh_token: response.refresh_token ?? null,
          expires_at: Date.now() + lifetimeMs,
          connected_at: connectedAt,
        };
        yield* writeRow(TOKENS_ROW, tokens);
        return tokens;
      });

    const currentTokens = (): Effect.Effect<StoredTokens | null, AgentcardStoreError> =>
      Effect.gen(function* () {
        const stored = yield* readRow(TOKENS_ROW);
        return stored === null ? null : yield* decodeStoredTokens(stored);
      });

    /** Usable as-is, with enough margin left that a tool call won't outlive it. */
    const isFresh = (tokens: StoredTokens): boolean =>
      tokens.expires_at === null || tokens.expires_at - REFRESH_MARGIN_MS > Date.now();

    /**
     * The grant the server refused is gone for good: clear it — unless a
     * concurrent refresh already replaced it, in which case the replacement
     * is the live grant and this failure was just the race's losing side.
     */
    const resolveRejectedGrant = (
      rejected: StoredTokens,
    ): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        yield* dropGrantIfUnchanged(rejected.access_token);
        const current = yield* currentTokens();
        if (current !== null && current.access_token !== rejected.access_token) {
          return current;
        }
        return yield* Effect.fail(new AgentcardError({ reason: "reauthorize" }));
      });

    /**
     * Trade the refresh token for a fresh pair. A grant the server has
     * forgotten is cleared rather than retried, so the UI reports a plain
     * "not connected" and the owner can reconnect.
     */
    const refresh = (tokens: StoredTokens): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        if (tokens.refresh_token === null) {
          return yield* resolveRejectedGrant(tokens);
        }

        const { token_endpoint: tokenEndpoint } = yield* serverMetadata;
        const exchanged = yield* requestJson({
          url: tokenEndpoint,
          method: "POST",
          form: {
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            client_id: tokens.client_id,
            ...(tokens.client_secret === null ? {} : { client_secret: tokens.client_secret }),
          },
        }).pipe(
          Effect.map((response) => ({ rejected: false as const, response })),
          Effect.catchTag("AgentcardError", (error) =>
            isGrantRejection(error)
              ? Effect.succeed({ rejected: true as const })
              : Effect.fail(error),
          ),
        );
        if (exchanged.rejected) {
          return yield* resolveRejectedGrant(tokens);
        }

        const decoded = yield* decodeTokenResponse(exchanged.response);
        return yield* storeTokens(
          { client_id: tokens.client_id, client_secret: tokens.client_secret },
          // A refresh response may omit the refresh token, which means keep
          // using the current one.
          {
            ...decoded,
            ...(decoded.refresh_token === undefined && tokens.refresh_token !== null
              ? { refresh_token: tokens.refresh_token }
              : {}),
          },
          tokens.connected_at,
        );
      });

    return {
      status: () =>
        Effect.gen(function* () {
          if (!hasDatabase()) {
            return { connected: false, connectedAt: null, canConnect: false };
          }
          const tokens = yield* currentTokens();
          return {
            connected: tokens !== null,
            connectedAt:
              tokens === null ? null : new Date(tokens.connected_at).toISOString(),
            canConnect: true,
          };
        }),

      beginAuthorization: (redirectUri) =>
        Effect.gen(function* () {
          const client = yield* clientFor(redirectUri);
          const { authorization_endpoint: authorizeEndpoint } = yield* serverMetadata;

          const verifier = base64url(randomBytes(32));
          const state = base64url(randomBytes(16));
          const challenge = base64url(createHash("sha256").update(verifier).digest());

          // One owner, so one authorization can be in flight; a new attempt
          // simply supersedes the last.
          yield* writeRow(PENDING_ROW, {
            state,
            verifier,
            redirect_uri: redirectUri,
            client_id: client.client_id,
            client_secret: client.client_secret,
            started_at: Date.now(),
          });

          const url = new URL(authorizeEndpoint);
          url.searchParams.set("response_type", "code");
          url.searchParams.set("client_id", client.client_id);
          url.searchParams.set("redirect_uri", redirectUri);
          url.searchParams.set("state", state);
          url.searchParams.set("code_challenge", challenge);
          url.searchParams.set("code_challenge_method", "S256");
          url.searchParams.set("resource", agentcardMcpUrl());
          return { url: url.toString() };
        }),

      completeAuthorization: ({ state, code }) =>
        Effect.gen(function* () {
          // Consumed only on a state match: a callback from an abandoned
          // earlier attempt fails here without touching the attempt that
          // superseded it, which can still complete normally.
          const stored = yield* takePending(state);
          if (stored === null) {
            return yield* Effect.fail(
              new AgentcardError({
                reason: "authorization_state",
                detail: "this sign-in is not the active one (stale tab, or already completed)",
              }),
            );
          }
          const pending = yield* decodePending(stored);
          if (Date.now() - pending.started_at > PENDING_TTL_MS) {
            return yield* Effect.fail(
              new AgentcardError({
                reason: "authorization_state",
                detail: "the sign-in took too long and expired",
              }),
            );
          }

          const { token_endpoint: tokenEndpoint } = yield* serverMetadata;
          const response = yield* requestJson({
            url: tokenEndpoint,
            method: "POST",
            form: {
              grant_type: "authorization_code",
              code,
              redirect_uri: pending.redirect_uri,
              client_id: pending.client_id,
              code_verifier: pending.verifier,
              ...(pending.client_secret === null
                ? {}
                : { client_secret: pending.client_secret }),
            },
          }).pipe(
            // A client the server has forgotten can never complete a sign-in,
            // and the stored registration would keep being reused. Drop it so
            // the next attempt registers a fresh one.
            Effect.catchTag("AgentcardError", (error) =>
              /invalid_client/.test(error.detail ?? "")
                ? deleteRow(CLIENT_ROW).pipe(Effect.andThen(Effect.fail(error)))
                : Effect.fail(error),
            ),
          );
          const decoded = yield* decodeTokenResponse(response);
          yield* storeTokens(
            { client_id: pending.client_id, client_secret: pending.client_secret },
            decoded,
            Date.now(),
          );
        }),

      accessToken: () =>
        Effect.gen(function* () {
          const tokens = yield* currentTokens();
          if (tokens === null) {
            return yield* Effect.fail(new AgentcardError({ reason: "not_connected" }));
          }
          if (isFresh(tokens)) {
            return { token: tokens.access_token, expiresAt: tokens.expires_at };
          }

          // Stale: refresh behind the gate, and re-read once inside it — a
          // caller that queued behind an in-flight refresh finds the fresh
          // grant already stored and skips its own exchange entirely.
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
        }),

      // Clears the registered client too, so Disconnect -> Connect is a full
      // reset: it is the owner's way out of any stale-registration state
      // without reaching into the database.
      disconnect: () =>
        Effect.gen(function* () {
          yield* deleteRow(TOKENS_ROW);
          yield* deleteRow(PENDING_ROW);
          yield* deleteRow(CLIENT_ROW);
        }),
    };
  }),
);

// Accessors: build programs against the service without resolving it, so call
// sites stay one-liners and tests can swap the layer.

export const agentcardStatus = (): Effect.Effect<
  AgentcardStatus,
  AgentcardStoreError,
  Agentcard
> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).status();
  });

export const beginAgentcardAuthorization = (
  redirectUri: string,
): Effect.Effect<{ url: string }, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).beginAuthorization(redirectUri);
  });

export const completeAgentcardAuthorization = (params: {
  readonly state: string;
  readonly code: string;
}): Effect.Effect<void, AgentcardStoreError, Agentcard> =>
  Effect.gen(function* () {
    return yield* (yield* Agentcard).completeAuthorization(params);
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
