import { Effect, Layer, Schema, Semaphore } from "effect";

import {
  Agentcard,
  AgentcardError,
  AgentcardStore,
  type AgentcardStoreError,
  COMPANY_PENDING_ROW,
  PENDING_TTL_MS,
  REFRESH_MARGIN_MS,
  type StoredTokens,
  agentcardApiUrl,
  agentcardOwnerEmail,
  isGrantRejection,
  makeGrantMachinery,
  requestJson,
} from "./agentcard";

// The company flow: this deployment holds company client credentials
// (AGENTCARD_CLIENT_ID / AGENTCARD_CLIENT_SECRET), the owner is its single
// connected user, and connecting is an emailed one-time code instead of a
// browser OAuth round trip — the shape that works from iMessage and Slack.
//
// Two credentials live here. The platform token (client_credentials) is
// derivable from env at any moment, so it is cached in memory only — never
// persisted. The user connection token from connect/verify is the grant the
// MCP connection spends with; it is stored like the personal grant, tagged
// mode: "company", and refreshed through connect/refresh, whose refresh
// tokens rotate on every use (hence the shared single-flight gate).
//
// The connect email is pinned to AGENTCARD_OWNER_EMAIL. Tools and routes
// cannot pass an address, so a prompt-injected model cannot aim the
// credential-granting code at an attacker's inbox.

const ConnectAttempt = Schema.Struct({
  id: Schema.String,
  expires_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const ConnectionTokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Finite,
  user: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      email: Schema.NullOr(Schema.String),
    }),
  ),
});

const PlatformToken = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Finite,
});

const CompanyPending = Schema.Struct({
  connect_id: Schema.String,
  started_at: Schema.Finite,
  /** The provider's own deadline, when it sent one. */
  expires_at: Schema.NullOr(Schema.String),
});

export const AgentcardCompanyLive = Layer.effect(
  Agentcard,
  Effect.gen(function* () {
    const store = yield* AgentcardStore;
    const grants = yield* makeGrantMachinery("company");
    const platformGate = yield* Semaphore.make(1);

    const decodeAttempt = Schema.decodeUnknownEffect(ConnectAttempt);
    const decodeConnection = Schema.decodeUnknownEffect(ConnectionTokens);
    const decodePlatform = Schema.decodeUnknownEffect(PlatformToken);
    const decodePending = Schema.decodeUnknownEffect(CompanyPending);

    // Memory only; see the module comment.
    let platform: { token: string; expiresAt: number } | null = null;

    const fetchPlatformToken = Effect.gen(function* () {
      const payload = yield* requestJson({
        url: `${agentcardApiUrl()}/api/v2/oauth/token`,
        method: "POST",
        form: {
          grant_type: "client_credentials",
          client_id: process.env.AGENTCARD_CLIENT_ID?.trim() ?? "",
          client_secret: process.env.AGENTCARD_CLIENT_SECRET?.trim() ?? "",
        },
      });
      const decoded = yield* decodePlatform(payload);
      platform = {
        token: decoded.access_token,
        expiresAt: Date.now() + decoded.expires_in * 1000,
      };
      return platform.token;
    });

    const platformToken = platformGate.withPermits(1)(
      Effect.suspend(() =>
        platform !== null && platform.expiresAt - REFRESH_MARGIN_MS > Date.now()
          ? Effect.succeed(platform.token)
          : fetchPlatformToken,
      ),
    );

    /**
     * One company API call under the platform bearer. A 401 means the cached
     * platform token died early (rotated server-side): drop it and try once
     * more with a fresh one before giving up.
     */
    const companyRequest = (
      path: string,
      json: unknown,
    ): Effect.Effect<unknown, AgentcardStoreError> =>
      Effect.gen(function* () {
        const attempt = (token: string) =>
          requestJson({
            url: `${agentcardApiUrl()}${path}`,
            method: "POST",
            json,
            headers: { authorization: `Bearer ${token}` },
          });
        const first = yield* platformToken;
        return yield* attempt(first).pipe(
          Effect.catchTag("AgentcardError", (error) => {
            if (error.status !== 401 || !/\bunauthorized\b/.test(error.detail ?? "")) {
              return Effect.fail(error);
            }
            platform = null;
            return Effect.gen(function* () {
              const second = yield* platformToken;
              return yield* attempt(second);
            });
          }),
        );
      });

    const storeConnection = (
      response: typeof ConnectionTokens.Type,
      connectedAt: number,
    ): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        const tokens: StoredTokens = {
          mode: "company",
          client_id: null,
          client_secret: null,
          access_token: response.access_token,
          refresh_token: response.refresh_token,
          expires_at: Date.now() + response.expires_in * 1000,
          connected_at: connectedAt,
          user_id: response.user?.id ?? null,
          email: response.user?.email ?? null,
        };
        yield* grants.storeTokens(tokens);
        return tokens;
      });

    const startConnect = (): Effect.Effect<
      { expiresAt: string | null },
      AgentcardStoreError
    > =>
      Effect.gen(function* () {
        const email = agentcardOwnerEmail();
        if (email === null) {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "not_configured",
              detail: "set AGENTCARD_OWNER_EMAIL to the address connect codes should go to",
            }),
          );
        }
        const payload = yield* companyRequest("/api/v2/connect/start", { email });
        const attempt = yield* decodeAttempt(payload);
        // One owner, one attempt in flight; a new start supersedes the last.
        yield* store.write(COMPANY_PENDING_ROW, {
          connect_id: attempt.id,
          started_at: Date.now(),
          expires_at: attempt.expires_at ?? null,
        });
        return { expiresAt: attempt.expires_at ?? null };
      });

    const verifyConnect = (code: string): Effect.Effect<void, AgentcardStoreError> =>
      Effect.gen(function* () {
        // Read, don't take: a mistyped code must leave the attempt in place
        // so the owner can just try again. The attempt is consumed only when
        // it succeeds, expires, or the provider declares it dead.
        const stored = yield* store.read(COMPANY_PENDING_ROW);
        if (stored === null) {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "authorization_state",
              detail:
                "no code is outstanding (it may have been used already) — start the connection again",
            }),
          );
        }
        const pending = yield* decodePending(stored);
        const deadline =
          pending.expires_at !== null
            ? Date.parse(pending.expires_at)
            : pending.started_at + PENDING_TTL_MS;
        // Every removal below is conditional on the connect_id this call
        // read: a newer attempt that superseded it mid-flight is a different
        // row value and survives, so its freshly emailed code still works.
        const removeThisAttempt = store.removeMatching(
          COMPANY_PENDING_ROW,
          "connect_id",
          pending.connect_id,
        );
        if (Number.isFinite(deadline) && Date.now() > deadline) {
          yield* removeThisAttempt;
          return yield* Effect.fail(
            new AgentcardError({
              reason: "authorization_state",
              detail: "the code expired — start the connection again",
            }),
          );
        }
        const payload = yield* companyRequest("/api/v2/connect/verify", {
          connect_id: pending.connect_id,
          code,
        }).pipe(
          // An attempt the provider no longer honours can never verify;
          // clear it so the next try says "start again" instead of looping.
          // Any other failure (wrong code, transient fault) keeps the
          // attempt retryable.
          Effect.catchTag("AgentcardError", (error) =>
            /invalid_connect_attempt/.test(error.detail ?? "")
              ? removeThisAttempt.pipe(Effect.andThen(Effect.fail(error)))
              : Effect.fail(error),
          ),
        );
        const connection = yield* decodeConnection(payload);
        yield* removeThisAttempt;
        const tokens = yield* storeConnection(connection, Date.now());
        // Consent is an audit record that also unlocks the Apple Pay /
        // Google Pay funding rail. Its failure must not undo a completed
        // connection the owner just verified by hand — degrade loudly.
        if (tokens.user_id !== null) {
          yield* companyRequest("/api/v2/connect/consent", { user_id: tokens.user_id }).pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                console.warn(
                  `agentcard: consent record failed: ${"detail" in error ? (error.detail ?? error.reason) : String(error)}`,
                ),
              ),
            ),
          );
        }
      });

    /** Trade the rotating refresh token for the next pair. */
    const refresh = (
      tokens: StoredTokens,
    ): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        if (tokens.refresh_token === null) {
          return yield* grants.resolveRejectedGrant(tokens);
        }
        const exchanged = yield* companyRequest("/api/v2/connect/refresh", {
          refresh_token: tokens.refresh_token,
        }).pipe(
          Effect.map((response) => ({ rejected: false as const, response })),
          Effect.catchTag("AgentcardError", (error) =>
            isGrantRejection(error)
              ? Effect.succeed({ rejected: true as const })
              : Effect.fail(error),
          ),
        );
        if (exchanged.rejected) {
          return yield* grants.resolveRejectedGrant(tokens);
        }
        const connection = yield* decodeConnection(exchanged.response);
        return yield* storeConnection(connection, tokens.connected_at);
      });

    return {
      status: () => grants.status(),
      accessToken: () => grants.accessTokenVia(refresh),
      disconnect: () => grants.disconnect(),
      flow: { mode: "company" as const, startConnect, verifyConnect },
    };
  }),
);
