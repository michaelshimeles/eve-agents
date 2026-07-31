import { Effect, Layer, Schema, Semaphore } from "effect";

import {
  AGENTCARD_TERMS_VERSION,
  Agentcard,
  type AgentcardAttachmentStartResult,
  type AgentcardAttachmentStatusResult,
  type AgentcardConnectTarget,
  AgentcardError,
  type AgentcardFundingSession,
  type AgentcardPhoneStartResult,
  AgentcardStore,
  type AgentcardStoreError,
  CONNECT_PENDING_ROW,
  PENDING_TTL_MS,
  type StoredTokens,
  agentcardApiUrl,
  agentcardConfigured,
  isGrantRejection,
  makeGrantMachinery,
  requestJson,
} from "./agentcard";

// Agentcard Connect API: this deployment holds dashboard-issued client
// credentials and connects a user with a one-time code delivered by email or
// phone. Every request is backend-to-backend; no secret, connect_id, or token
// is returned to the browser.
//
// Two credentials live here. The platform token (client_credentials) is
// derivable from env at any moment, so it is cached in memory only — never
// persisted. The user connection token from connect/verify is the grant the
// MCP connection spends with; it is encrypted per Agentcard user and refreshed
// through connect/refresh, whose refresh tokens rotate on every use.

const ConnectAttempt = Schema.Struct({
  id: Schema.String,
  channel: Schema.Literals(["email", "phone"]),
  expires_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const TokenPair = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Finite,
});

const VerifiedConnection = Schema.Struct({
  ...TokenPair.fields,
  user: Schema.Struct({
    id: Schema.String,
    email: Schema.NullOr(Schema.String),
    phone: Schema.NullOr(Schema.String),
  }),
});

const PlatformToken = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optionalKey(Schema.Finite),
});

const AttachmentCard = Schema.Struct({
  brand: Schema.optionalKey(Schema.NullOr(Schema.String)),
  last4: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const AttachmentResponse = Schema.Struct({
  status: Schema.Literals(["pending", "active", "ineligible"]),
  attach_url: Schema.optionalKey(Schema.String),
  expires_at: Schema.optionalKey(Schema.String),
  card: Schema.optionalKey(AttachmentCard),
  reason: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

const PhoneVerification = Schema.Struct({
  status: Schema.Literals(["sent", "already_verified", "verified"]),
  channel: Schema.optionalKey(Schema.Literals(["sms", "email"])),
  phone: Schema.optionalKey(Schema.String),
  expires_in_seconds: Schema.optionalKey(Schema.Finite),
});

const FundingSession = Schema.Struct({
  checkout_url: Schema.String,
  expires_at: Schema.String,
  amount_cents: Schema.Finite,
  payment_method: Schema.Literals(["apple_pay", "google_pay"]),
});

const ConnectPending = Schema.Struct({
  connect_id: Schema.String,
  started_at: Schema.Finite,
  /** The provider's own deadline, when it sent one. */
  expires_at: Schema.NullOr(Schema.String),
});

/** Platform bearers live for an hour; retire our copy after about 55 minutes. */
const PLATFORM_TOKEN_CACHE_MS = 55 * 60_000;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/**
 * Provider links are relayed to the owner. Production must be HTTPS; local
 * HTTP is accepted only when both the API and returned link are loopback.
 */
function safeProviderUrl(value: string): boolean {
  try {
    const target = new URL(value);
    if (target.protocol === "https:") return true;
    const api = new URL(agentcardApiUrl());
    return (
      target.protocol === "http:" &&
      api.protocol === "http:" &&
      isLoopback(target.hostname) &&
      isLoopback(api.hostname)
    );
  } catch {
    return false;
  }
}

export const AgentcardConnectLive = Layer.effect(
  Agentcard,
  Effect.gen(function* () {
    const store = yield* AgentcardStore;
    const grants = yield* makeGrantMachinery();
    const platformGate = yield* Semaphore.make(1);

    const decodeAttempt = Schema.decodeUnknownEffect(ConnectAttempt);
    const decodeTokenPair = Schema.decodeUnknownEffect(TokenPair);
    const decodeVerifiedConnection = Schema.decodeUnknownEffect(VerifiedConnection);
    const decodePlatform = Schema.decodeUnknownEffect(PlatformToken);
    const decodePending = Schema.decodeUnknownEffect(ConnectPending);
    const decodeAttachment = Schema.decodeUnknownEffect(AttachmentResponse);
    const decodePhoneVerification = Schema.decodeUnknownEffect(PhoneVerification);
    const decodeFundingSession = Schema.decodeUnknownEffect(FundingSession);

    // Memory only; see the module comment.
    let platform: { token: string; expiresAt: number } | null = null;

    const fetchPlatformToken = Effect.gen(function* () {
      if (!agentcardConfigured()) {
        return yield* Effect.fail(
          new AgentcardError({
            reason: "not_configured",
            detail:
              "set AGENTCARD_CLIENT_ID and AGENTCARD_CLIENT_SECRET as backend environment variables",
          }),
        );
      }
      const payload = yield* requestJson({
        url: `${agentcardApiUrl()}/api/v2/oauth/token`,
        method: "POST",
        form: {
          grant_type: "client_credentials",
          client_id: process.env.AGENTCARD_CLIENT_ID?.trim() ?? "",
          client_secret: process.env.AGENTCARD_CLIENT_SECRET?.trim() ?? "",
        },
        retry: true,
      });
      const decoded = yield* decodePlatform(payload);
      const providerTtl =
        decoded.expires_in === undefined
          ? PLATFORM_TOKEN_CACHE_MS
          : Math.max(0, decoded.expires_in * 1000 - 60_000);
      platform = {
        token: decoded.access_token,
        expiresAt: Date.now() + Math.min(PLATFORM_TOKEN_CACHE_MS, providerTtl),
      };
      return platform.token;
    });

    const platformToken = platformGate.withPermits(1)(
      Effect.suspend(() =>
        platform !== null && platform.expiresAt > Date.now()
          ? Effect.succeed(platform.token)
          : fetchPlatformToken,
      ),
    );

    /**
     * One company API call under the platform bearer. A 401 means the cached
     * platform token died early (rotated server-side): drop it and try once
     * more with a fresh one before giving up.
     */
    const platformRequest = (
      path: string,
      options: {
        readonly method?: "GET" | "POST";
        readonly json?: unknown;
        readonly query?: Readonly<Record<string, string>>;
      } = {},
    ): Effect.Effect<unknown, AgentcardStoreError> =>
      Effect.gen(function* () {
        const query =
          options.query === undefined
            ? ""
            : `?${new URLSearchParams(options.query).toString()}`;
        const attempt = (token: string) =>
          requestJson({
            url: `${agentcardApiUrl()}${path}${query}`,
            method: options.method ?? "POST",
            ...(options.json === undefined ? {} : { json: options.json }),
            headers: { authorization: `Bearer ${token}` },
          });
        const first = yield* platformToken;
        return yield* attempt(first).pipe(
          Effect.catchTag("AgentcardError", (error) => {
            if (
              error.status !== 401 ||
              (error.code !== "unauthorized" &&
                !/\bunauthorized\b/.test(error.detail ?? ""))
            ) {
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
      response: typeof TokenPair.Type,
      user: {
        readonly id: string;
        readonly email: string | null;
        readonly phone: string | null;
      },
      connectedAt: number,
    ): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        const tokens: StoredTokens = {
          access_token: response.access_token,
          refresh_token: response.refresh_token,
          expires_at: Date.now() + response.expires_in * 1000,
          connected_at: connectedAt,
          user_id: user.id,
          email: user.email,
          phone: user.phone,
        };
        yield* grants.storeTokens(tokens);
        return tokens;
      });

    const startConnect = (
      target: AgentcardConnectTarget,
    ): Effect.Effect<
      { expiresAt: string | null; channel: "email" | "phone" },
      AgentcardStoreError
    > =>
      Effect.gen(function* () {
        const payload = yield* platformRequest("/api/v2/connect/start", {
          json: target,
        });
        const attempt = yield* decodeAttempt(payload);
        // One owner, one attempt in flight; a new start supersedes the last.
        yield* store.write(CONNECT_PENDING_ROW, {
          connect_id: attempt.id,
          started_at: Date.now(),
          expires_at: attempt.expires_at ?? null,
        });
        return {
          expiresAt: attempt.expires_at ?? null,
          channel: attempt.channel,
        };
      });

    const verifyConnect = (params: {
      readonly code: string;
      readonly consent: boolean;
    }): Effect.Effect<void, AgentcardStoreError> =>
      Effect.gen(function* () {
        if (!params.consent) {
          return yield* Effect.fail(new AgentcardError({ reason: "consent_required" }));
        }
        // Read, don't take: a mistyped code must leave the attempt in place
        // so the owner can just try again. The attempt is consumed only when
        // it succeeds, expires, or the provider declares it dead.
        const stored = yield* store.read(CONNECT_PENDING_ROW);
        if (stored === null) {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "authorization_state",
              code: "invalid_connect_attempt",
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
          CONNECT_PENDING_ROW,
          "connect_id",
          pending.connect_id,
        );
        if (Number.isFinite(deadline) && Date.now() > deadline) {
          yield* removeThisAttempt;
          return yield* Effect.fail(
            new AgentcardError({
              reason: "authorization_state",
              code: "invalid_connect_attempt",
              detail: "the code expired — start the connection again",
            }),
          );
        }
        const payload = yield* platformRequest("/api/v2/connect/verify", {
          json: {
            connect_id: pending.connect_id,
            code: params.code,
          },
        }).pipe(
          // An attempt the provider no longer honours can never verify;
          // clear it so the next try says "start again" instead of looping.
          // Any other failure (wrong code, transient fault) keeps the
          // attempt retryable.
          Effect.catchTag("AgentcardError", (error) =>
            error.code === "invalid_connect_attempt" ||
            /invalid_connect_attempt/.test(error.detail ?? "")
              ? removeThisAttempt.pipe(Effect.andThen(Effect.fail(error)))
              : Effect.fail(error),
          ),
        );
        // A successful verify consumes the code at Agentcard even if their
        // response is malformed or consent recording later fails.
        yield* removeThisAttempt;
        const connection = yield* decodeVerifiedConnection(payload);
        // Consent is mandatory and precedes persistence. If it fails, no
        // usable connection is stored and the owner must restart.
        yield* platformRequest("/api/v2/connect/consent", {
          json: {
            user_id: connection.user.id,
            terms_version: AGENTCARD_TERMS_VERSION,
          },
        });
        yield* storeConnection(connection, connection.user, Date.now());
      });

    const connectedTokens = (): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        const tokens = yield* grants.currentTokens();
        if (tokens === null) {
          return yield* Effect.fail(
            new AgentcardError({ reason: "not_connected" }),
          );
        }
        return tokens;
      });

    const attachedCard = (
      decoded: typeof AttachmentResponse.Type,
    ): { brand: string | null; last4: string | null } => ({
      brand: decoded.card?.brand ?? null,
      last4: decoded.card?.last4 ?? null,
    });

    const decodeAttachmentStart = (
      payload: unknown,
    ): Effect.Effect<AgentcardAttachmentStartResult, AgentcardStoreError> =>
      Effect.gen(function* () {
        const decoded = yield* decodeAttachment(payload);
        switch (decoded.status) {
          case "active":
            return { status: "active", card: attachedCard(decoded) };
          case "ineligible":
            return {
              status: "ineligible",
              reason: decoded.reason ?? "unknown",
              message:
                decoded.message ??
                "This card cannot be attached. Use wallet funding instead.",
            };
          case "pending": {
            if (
              decoded.attach_url === undefined ||
              decoded.expires_at === undefined ||
              !safeProviderUrl(decoded.attach_url)
            ) {
              return yield* Effect.fail(
                new AgentcardError({
                  reason: "provider",
                  code: "invalid_response",
                  detail:
                    "Agentcard returned a pending attachment without a safe attach_url and expiry",
                }),
              );
            }
            return {
              status: "pending",
              attachUrl: decoded.attach_url,
              expiresAt: decoded.expires_at,
            };
          }
        }
      });

    const decodeAttachmentStatus = (
      payload: unknown,
    ): Effect.Effect<AgentcardAttachmentStatusResult, AgentcardStoreError> =>
      Effect.gen(function* () {
        const decoded = yield* decodeAttachment(payload);
        switch (decoded.status) {
          case "active":
            return { status: "active", card: attachedCard(decoded) };
          case "pending":
            return { status: "pending" };
          case "ineligible":
            return {
              status: "ineligible",
              reason: decoded.reason ?? "unknown",
              message:
                decoded.message ??
                "This card cannot be attached. Use wallet funding instead.",
            };
        }
      });

    const startAttachment = (): Effect.Effect<
      AgentcardAttachmentStartResult,
      AgentcardStoreError
    > =>
      Effect.gen(function* () {
        type StartRequest =
          | { readonly type: "response"; readonly payload: unknown }
          | {
              readonly type: "result";
              readonly result: AgentcardAttachmentStartResult;
            };
        const tokens = yield* connectedTokens();
        const requested = yield* platformRequest("/api/v2/attach", {
          json: { user_id: tokens.user_id },
        }).pipe(
          Effect.map((payload): StartRequest => ({
            type: "response" as const,
            payload,
          })),
          Effect.catchTag(
            "AgentcardError",
            (error): Effect.Effect<StartRequest, AgentcardError> => {
            if (error.status === 422 && error.code === "user_info_required") {
              return Effect.succeed<StartRequest>({
                type: "result" as const,
                result: {
                  status: "user_info_required" as const,
                  missingFields: error.missingFields ?? [],
                  message:
                    error.detail ??
                    "A verified phone number and recorded consent are required first.",
                },
              });
            }
            if (
              (error.status === 403 || error.status === 503) &&
              error.code === "attach_unavailable"
            ) {
              return Effect.succeed<StartRequest>({
                type: "result" as const,
                result: {
                  status: "unavailable" as const,
                  message:
                    error.detail ??
                    "Card attachment is unavailable. Use wallet funding instead.",
                },
              });
            }
            return Effect.fail(error);
            },
          ),
        );
        return requested.type === "result"
          ? requested.result
          : yield* decodeAttachmentStart(requested.payload);
      });

    const attachmentStatus = (): Effect.Effect<
      AgentcardAttachmentStatusResult,
      AgentcardStoreError
    > =>
      Effect.gen(function* () {
        type StatusRequest =
          | { readonly type: "response"; readonly payload: unknown }
          | {
              readonly type: "result";
              readonly result: AgentcardAttachmentStatusResult;
            };
        const tokens = yield* connectedTokens();
        const requested = yield* platformRequest("/api/v2/attach", {
          method: "GET",
          query: { user_id: tokens.user_id },
        }).pipe(
          Effect.map((payload): StatusRequest => ({
            type: "response" as const,
            payload,
          })),
          Effect.catchTag(
            "AgentcardError",
            (error): Effect.Effect<StatusRequest, AgentcardError> => {
            if (error.status === 404 && error.code === "no_attachment") {
              return Effect.succeed<StatusRequest>({
                type: "result" as const,
                result: { status: "no_attachment" as const },
              });
            }
            if (
              (error.status === 403 || error.status === 503) &&
              error.code === "attach_unavailable"
            ) {
              return Effect.succeed<StatusRequest>({
                type: "result" as const,
                result: {
                  status: "unavailable" as const,
                  message:
                    error.detail ??
                    "Card attachment is unavailable. Use wallet funding instead.",
                },
              });
            }
            return Effect.fail(error);
            },
          ),
        );
        return requested.type === "result"
          ? requested.result
          : yield* decodeAttachmentStatus(requested.payload);
      });

    const recordConsent = (): Effect.Effect<void, AgentcardStoreError> =>
      Effect.gen(function* () {
        const tokens = yield* connectedTokens();
        yield* platformRequest("/api/v2/connect/consent", {
          json: {
            user_id: tokens.user_id,
            terms_version: AGENTCARD_TERMS_VERSION,
          },
        });
      });

    const startPhoneVerification = (params: {
      readonly phoneNumber?: string;
    }): Effect.Effect<AgentcardPhoneStartResult, AgentcardStoreError> =>
      Effect.gen(function* () {
        const tokens = yield* connectedTokens();
        const phoneNumber = params.phoneNumber?.trim();
        if (
          phoneNumber !== undefined &&
          phoneNumber.length > 0 &&
          !E164_PATTERN.test(phoneNumber)
        ) {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "provider",
              code: "invalid_request",
              detail: "phone_number must be in E.164 format, such as +14155550123",
            }),
          );
        }
        const payload = yield* platformRequest("/api/v2/wallet/phone/start", {
          json: {
            user_id: tokens.user_id,
            ...(tokens.phone === null &&
            phoneNumber !== undefined &&
            phoneNumber.length > 0
              ? { phone_number: phoneNumber }
              : {}),
          },
        });
        const result = yield* decodePhoneVerification(payload);
        if (result.status === "already_verified" || result.status === "verified") {
          return { status: "already_verified" };
        }
        if (
          result.channel === undefined ||
          result.phone === undefined ||
          result.expires_in_seconds === undefined
        ) {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "provider",
              code: "invalid_response",
              detail: "Agentcard did not return the phone verification destination",
            }),
          );
        }
        return {
          status: "sent",
          channel: result.channel,
          phone: result.phone,
          expiresInSeconds: result.expires_in_seconds,
        };
      });

    const verifyPhone = (params: {
      readonly code: string;
      readonly phoneNumber?: string;
    }): Effect.Effect<void, AgentcardStoreError> =>
      Effect.gen(function* () {
        const tokens = yield* connectedTokens();
        const phoneNumber = params.phoneNumber?.trim();
        if (
          phoneNumber !== undefined &&
          phoneNumber.length > 0 &&
          !E164_PATTERN.test(phoneNumber)
        ) {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "provider",
              code: "invalid_request",
              detail: "phone_number must be in E.164 format, such as +14155550123",
            }),
          );
        }
        const payload = yield* platformRequest("/api/v2/wallet/phone/verify", {
          json: {
            user_id: tokens.user_id,
            code: params.code.trim(),
            ...(tokens.phone === null &&
            phoneNumber !== undefined &&
            phoneNumber.length > 0
              ? { phone_number: phoneNumber }
              : {}),
          },
        });
        const result = yield* decodePhoneVerification(payload);
        if (result.status !== "verified" && result.status !== "already_verified") {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "provider",
              code: "invalid_response",
              detail: "Agentcard did not confirm the phone verification",
            }),
          );
        }
        if (tokens.phone === null && phoneNumber !== undefined && phoneNumber.length > 0) {
          yield* grants.storeTokens({ ...tokens, phone: phoneNumber });
        }
      });

    const fundWallet = (params: {
      readonly amountCents: number;
      readonly paymentMethod: "apple_pay" | "google_pay";
    }): Effect.Effect<AgentcardFundingSession, AgentcardStoreError> =>
      Effect.gen(function* () {
        if (!Number.isSafeInteger(params.amountCents) || params.amountCents <= 0) {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "provider",
              code: "invalid_request",
              detail: "amount_cents must be a positive integer",
            }),
          );
        }
        const tokens = yield* connectedTokens();
        const payload = yield* platformRequest("/api/v2/wallet/fund", {
          json: {
            user_id: tokens.user_id,
            amount_cents: params.amountCents,
            payment_method: params.paymentMethod,
            link_type: "hosted",
          },
        });
        const session = yield* decodeFundingSession(payload);
        if (!safeProviderUrl(session.checkout_url)) {
          return yield* Effect.fail(
            new AgentcardError({
              reason: "provider",
              code: "invalid_response",
              detail: "Agentcard returned an unsafe wallet funding URL",
            }),
          );
        }
        return {
          checkoutUrl: session.checkout_url,
          expiresAt: session.expires_at,
          amountCents: session.amount_cents,
          paymentMethod: session.payment_method,
        };
      });

    /** Trade the rotating refresh token for the next pair. */
    const refresh = (
      tokens: StoredTokens,
    ): Effect.Effect<StoredTokens, AgentcardStoreError> =>
      Effect.gen(function* () {
        const exchanged = yield* platformRequest("/api/v2/connect/refresh", {
          json: {
            refresh_token: tokens.refresh_token,
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
        const connection = yield* decodeTokenPair(exchanged.response);
        return yield* storeConnection(
          connection,
          { id: tokens.user_id, email: tokens.email, phone: tokens.phone },
          tokens.connected_at,
        );
      });

    return {
      status: () => grants.status(),
      accessToken: () => grants.accessTokenVia(refresh),
      refreshAfterRejection: (rejectedAccessToken) =>
        grants.refreshAfterRejectionVia(rejectedAccessToken, refresh),
      disconnect: () => grants.disconnect(),
      flow: {
        startConnect,
        verifyConnect,
        startAttachment,
        attachmentStatus,
        recordConsent,
        startPhoneVerification,
        verifyPhone,
        fundWallet,
      },
    };
  }),
);
