import { createHash, randomBytes } from "node:crypto";

import { Effect, Layer, Schema } from "effect";

import {
  ASSUMED_TOKEN_TTL_MS,
  Agentcard,
  AgentcardError,
  AgentcardStore,
  type AgentcardStoreError,
  CLIENT_ROW,
  PENDING_ROW,
  PENDING_TTL_MS,
  type StoredTokens,
  agentcardMcpUrl,
  isGrantRejection,
  makeGrantMachinery,
  requestJson,
} from "./agentcard";

// The personal flow: the owner's own Agentcard account, connected once in
// the browser (Manage -> Card, via app/api/agentcard/*). The MCP server
// speaks OAuth 2.1 only — no API keys — so this module drives the whole
// dance: everything is discovered from the server's own metadata documents,
// and the client is registered dynamically (RFC 7591), so there is no client
// id to configure by hand.

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

const StoredClient = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.NullOr(Schema.String),
  /** Registered redirect URI; a different app origin needs its own client. */
  redirect_uri: Schema.String,
});
type StoredClient = typeof StoredClient.Type;

const PendingAuthorization = Schema.Struct({
  state: Schema.String,
  verifier: Schema.String,
  redirect_uri: Schema.String,
  client_id: Schema.String,
  client_secret: Schema.NullOr(Schema.String),
  started_at: Schema.Finite,
});

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export const AgentcardPersonalLive = Layer.effect(
  Agentcard,
  Effect.gen(function* () {
    const store = yield* AgentcardStore;
    const grants = yield* makeGrantMachinery("personal");

    const decodeMetadata = Schema.decodeUnknownEffect(ServerMetadata);
    const decodeRegistration = Schema.decodeUnknownEffect(RegistrationResponse);
    const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
    const decodeStoredClient = Schema.decodeUnknownEffect(StoredClient);
    const decodePending = Schema.decodeUnknownEffect(PendingAuthorization);

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
        const stored = yield* store.read(CLIENT_ROW);
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
        yield* store.write(CLIENT_ROW, client);
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
          mode: "personal",
          client_id: client.client_id,
          client_secret: client.client_secret,
          access_token: response.access_token,
          refresh_token: response.refresh_token ?? null,
          expires_at: Date.now() + lifetimeMs,
          connected_at: connectedAt,
          user_id: null,
          email: null,
        };
        yield* grants.storeTokens(tokens);
        return tokens;
      });

    /**
     * Trade the refresh token for a fresh pair. A grant the server has
     * forgotten is cleared rather than retried, so the UI reports a plain
     * "not connected" and the owner can reconnect.
     */
    const refresh = (tokens: StoredTokens): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        if (tokens.refresh_token === null || tokens.client_id === null) {
          return yield* grants.resolveRejectedGrant(tokens);
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
          return yield* grants.resolveRejectedGrant(tokens);
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

    const beginAuthorization = (
      redirectUri: string,
    ): Effect.Effect<{ url: string }, AgentcardStoreError> =>
      Effect.gen(function* () {
        const client = yield* clientFor(redirectUri);
        const { authorization_endpoint: authorizeEndpoint } = yield* serverMetadata;

        const verifier = base64url(randomBytes(32));
        const state = base64url(randomBytes(16));
        const challenge = base64url(createHash("sha256").update(verifier).digest());

        // One owner, so one authorization can be in flight; a new attempt
        // simply supersedes the last.
        yield* store.write(PENDING_ROW, {
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
      });

    const completeAuthorization = ({
      state,
      code,
    }: {
      readonly state: string;
      readonly code: string;
    }): Effect.Effect<void, AgentcardStoreError> =>
      Effect.gen(function* () {
        // Consumed only on a state match: a callback from an abandoned
        // earlier attempt fails here without touching the attempt that
        // superseded it, which can still complete normally.
        const stored = yield* store.takeMatching(PENDING_ROW, "state", state);
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
              ? store.remove(CLIENT_ROW).pipe(Effect.andThen(Effect.fail(error)))
              : Effect.fail(error),
          ),
        );
        const decoded = yield* decodeTokenResponse(response);
        yield* storeTokens(
          { client_id: pending.client_id, client_secret: pending.client_secret },
          decoded,
          Date.now(),
        );
      });

    return {
      status: () => grants.status(),
      accessToken: () => grants.accessTokenVia(refresh),
      disconnect: () => grants.disconnect(),
      flow: { mode: "personal" as const, beginAuthorization, completeAuthorization },
    };
  }),
);
