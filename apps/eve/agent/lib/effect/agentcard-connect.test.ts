import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_CONNECTION_ROW,
  AGENTCARD_TERMS_VERSION,
  AgentcardStore,
  CONNECT_PENDING_ROW,
  agentcardAccessToken,
  agentcardConnectionRowName,
  refreshAgentcardAfterMcpUnauthorized,
  startAgentcardConnect,
  verifyAgentcardConnect,
} from "./agentcard";
import { AgentcardConnectLive } from "./agentcard-connect";
import { AgentcardStoreMemory } from "./agentcard.testing";

// The Connect API moves real money on the strength of these exchanges, so
// the tests pin the wire shapes, mandatory consent, encrypted persistence,
// provider error branches, and refresh-token rotation.

const API = "https://api.test";
const FUTURE_EXPIRY = new Date(Date.now() + 600_000).toISOString();

function connectRuntime() {
  vi.stubEnv("AGENTCARD_CLIENT_ID", "cl_1");
  vi.stubEnv("AGENTCARD_CLIENT_SECRET", "acs_1");
  vi.stubEnv("AGENTCARD_API_URL", API);
  return ManagedRuntime.make(
    Layer.mergeAll(
      AgentcardStoreMemory,
      AgentcardConnectLive.pipe(Layer.provide(AgentcardStoreMemory)),
    ),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Handler = (
  url: string,
  init: RequestInit,
) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

/** Routes fetch by URL suffix and records every backend request. */
function stubFetch(handlers: Record<string, Handler>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const handler = Object.entries(handlers).find(([suffix]) => url.endsWith(suffix))?.[1];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    const { status, body } = await handler(url, init);
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

const platformGrant: Handler = () => ({
  status: 200,
  body: { access_token: "plat_1" },
});

const verifiedConnection = {
  access_token: "user_at_1",
  refresh_token: "user_rt_1",
  expires_in: 3600,
  user: {
    id: "user_1",
    email: "owner@example.com",
    phone: null,
  },
};

const attempt = (
  id: string,
  channel: "email" | "phone" = "email",
): Handler => () => ({
  status: 201,
  body: {
    id,
    channel,
    expires_at: FUTURE_EXPIRY,
  },
});

const consent: Handler = () => ({
  status: 201,
  body: { id: "cns_1" },
});

async function connect(rt: ReturnType<typeof connectRuntime>): Promise<void> {
  await rt.runPromise(
    Effect.gen(function* () {
      yield* startAgentcardConnect({ email: "owner@example.com" });
      yield* verifyAgentcardConnect({ code: "111111", consent: true });
    }),
  );
}

describe("Connect API", () => {
  it("form-encodes the platform grant and sends exactly one email under its bearer", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
    });
    const rt = connectRuntime();

    const result = await rt.runPromise(
      startAgentcardConnect({ email: "owner@example.com" }),
    );
    expect(result).toEqual({
      channel: "email",
      expiresAt: FUTURE_EXPIRY,
    });

    const grant = calls.find((call) => call.url.endsWith("/oauth/token"))!;
    expect(grant.init.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
    const form = new URLSearchParams(String(grant.init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      client_id: "cl_1",
      client_secret: "acs_1",
    });

    const start = calls.find((call) => call.url.endsWith("/connect/start"))!;
    expect(start.init.headers).toMatchObject({ authorization: "Bearer plat_1" });
    expect(JSON.parse(String(start.init.body))).toEqual({
      email: "owner@example.com",
    });
  });

  it("supports an E.164 phone target without also sending email", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_phone", "phone"),
    });
    const rt = connectRuntime();

    const result = await rt.runPromise(
      startAgentcardConnect({ phone: "+14165550123" }),
    );
    expect(result.channel).toBe("phone");
    const start = calls.find((call) => call.url.endsWith("/connect/start"))!;
    expect(JSON.parse(String(start.init.body))).toEqual({
      phone: "+14165550123",
    });
  });

  it("records versioned consent before storing a per-user encrypted token pair", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      "/api/v2/connect/verify": () => ({
        status: 200,
        body: verifiedConnection,
      }),
      "/api/v2/connect/consent": consent,
    });
    const rt = connectRuntime();

    await connect(rt);

    const verify = calls.find((call) => call.url.endsWith("/connect/verify"))!;
    expect(JSON.parse(String(verify.init.body))).toEqual({
      connect_id: "ca_1",
      code: "111111",
    });
    const consentCall = calls.find((call) => call.url.endsWith("/connect/consent"))!;
    expect(JSON.parse(String(consentCall.init.body))).toEqual({
      user_id: "user_1",
      terms_version: AGENTCARD_TERMS_VERSION,
    });
    expect(calls.indexOf(verify)).toBeLessThan(calls.indexOf(consentCall));

    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        const pointer = yield* store.read(ACTIVE_CONNECTION_ROW);
        expect(pointer).toEqual({
          kind: "agentcard_active_connection",
          user_id: "user_1",
        });
        const raw = yield* store.read(agentcardConnectionRowName("user_1"));
        expect(raw).toMatchObject({
          kind: "agentcard_connection",
          user_id: "user_1",
          email: "owner@example.com",
        });
        const serialized = JSON.stringify(raw);
        expect(serialized).not.toContain("user_at_1");
        expect(serialized).not.toContain("user_rt_1");
        expect(serialized).toContain("ciphertext");

        const access = yield* agentcardAccessToken();
        expect(access.token).toBe("user_at_1");
      }),
    );
  });

  it("requires explicit consent before consuming the code or storing tokens", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
    });
    const rt = connectRuntime();
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        yield* startAgentcardConnect({ email: "owner@example.com" });
        yield* verifyAgentcardConnect({ code: "111111", consent: false });
      }),
    );

    expect(exit._tag).toBe("Failure");
    expect(calls.some((call) => call.url.endsWith("/connect/verify"))).toBe(false);
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        expect(yield* store.read(CONNECT_PENDING_ROW)).not.toBeNull();
        expect(yield* store.read(ACTIVE_CONNECTION_ROW)).toBeNull();
      }),
    );
  });

  it("does not store a connection when mandatory consent recording fails", async () => {
    stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      "/api/v2/connect/verify": () => ({
        status: 200,
        body: verifiedConnection,
      }),
      "/api/v2/connect/consent": () => ({
        status: 500,
        body: {
          error: {
            code: "consent_failed",
            message: "could not record consent",
            docs: "https://docs.test/consent",
          },
        },
      }),
    });
    const rt = connectRuntime();
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        yield* startAgentcardConnect({ email: "owner@example.com" });
        yield* verifyAgentcardConnect({ code: "111111", consent: true });
      }),
    );

    expect(exit._tag).toBe("Failure");
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        expect(yield* store.read(CONNECT_PENDING_ROW)).toBeNull();
        expect(yield* store.read(ACTIVE_CONNECTION_ROW)).toBeNull();
        expect(yield* store.read(agentcardConnectionRowName("user_1"))).toBeNull();
      }),
    );
  });

  it("branches on nested invalid_code and keeps the attempt retryable", async () => {
    stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      "/api/v2/connect/verify": (_url, init) =>
        JSON.parse(String(init.body)).code === "111111"
          ? { status: 200, body: verifiedConnection }
          : {
              status: 401,
              body: {
                error: {
                  code: "invalid_code",
                  message: "code invalid or expired",
                  docs: "https://docs.test/codes",
                },
              },
            },
      "/api/v2/connect/consent": consent,
    });
    const rt = connectRuntime();
    await rt.runPromise(startAgentcardConnect({ email: "owner@example.com" }));

    const wrong = await rt.runPromiseExit(
      verifyAgentcardConnect({ code: "000000", consent: true }),
    );
    expect(wrong._tag).toBe("Failure");
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        expect(yield* store.read(CONNECT_PENDING_ROW)).not.toBeNull();
      }),
    );

    await rt.runPromise(
      verifyAgentcardConnect({ code: "111111", consent: true }),
    );
    const token = await rt.runPromise(agentcardAccessToken());
    expect(token.token).toBe("user_at_1");
  });

  it("clears invalid_connect_attempt so the caller can restart", async () => {
    stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      "/api/v2/connect/verify": () => ({
        status: 400,
        body: {
          error: {
            code: "invalid_connect_attempt",
            message: "attempt expired",
          },
        },
      }),
    });
    const rt = connectRuntime();
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        yield* startAgentcardConnect({ email: "owner@example.com" });
        yield* verifyAgentcardConnect({ code: "111111", consent: true });
      }),
    );

    expect(exit._tag).toBe("Failure");
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        expect(yield* store.read(CONNECT_PENDING_ROW)).toBeNull();
      }),
    );
  });
});

describe("platform bearer cache", () => {
  it("accepts the documented access_token-only response and reuses it", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
    });
    const rt = connectRuntime();

    await rt.runPromise(startAgentcardConnect({ email: "one@example.com" }));
    await rt.runPromise(startAgentcardConnect({ email: "two@example.com" }));

    expect(calls.filter((call) => call.url.endsWith("/oauth/token"))).toHaveLength(1);
  });

  it("retires its in-memory platform bearer after about 55 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
    });
    const rt = connectRuntime();

    await rt.runPromise(startAgentcardConnect({ email: "owner@example.com" }));
    vi.advanceTimersByTime(54 * 60_000);
    await rt.runPromise(startAgentcardConnect({ email: "owner@example.com" }));
    expect(calls.filter((call) => call.url.endsWith("/oauth/token"))).toHaveLength(1);

    vi.advanceTimersByTime(2 * 60_000);
    await rt.runPromise(startAgentcardConnect({ email: "owner@example.com" }));
    expect(calls.filter((call) => call.url.endsWith("/oauth/token"))).toHaveLength(2);
  });

  it("drops and refetches a cached platform bearer after unauthorized", async () => {
    let starts = 0;
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": () => {
        starts += 1;
        return starts === 1
          ? {
              status: 401,
              body: { error: { code: "unauthorized", message: "expired" } },
            }
          : {
              status: 201,
              body: {
                id: "ca_2",
                channel: "email",
                expires_at: null,
              },
            };
      },
    });
    const rt = connectRuntime();

    await rt.runPromise(startAgentcardConnect({ email: "owner@example.com" }));

    expect(calls.filter((call) => call.url.endsWith("/oauth/token"))).toHaveLength(2);
    expect(starts).toBe(2);
  });
});

describe("rotating refresh tokens", () => {
  it("conditionally rotates both tokens after an MCP 401 and reuses a concurrent winner", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      "/api/v2/connect/verify": () => ({
        status: 200,
        body: verifiedConnection,
      }),
      "/api/v2/connect/consent": consent,
      "/api/v2/connect/refresh": () => ({
        status: 200,
        body: {
          access_token: "user_at_2",
          refresh_token: "user_rt_2",
          expires_in: 3600,
        },
      }),
    });
    const rt = connectRuntime();
    await connect(rt);

    const refreshed = await rt.runPromise(
      refreshAgentcardAfterMcpUnauthorized("user_at_1"),
    );
    expect(refreshed.token).toBe("user_at_2");

    // A second MCP session rejected the old bearer too. Because the stored
    // pair has already changed, it must reuse the winner rather than rotate
    // the winner's refresh token again.
    const concurrent = await rt.runPromise(
      refreshAgentcardAfterMcpUnauthorized("user_at_1"),
    );
    expect(concurrent.token).toBe("user_at_2");

    const refreshes = calls.filter((call) =>
      call.url.endsWith("/connect/refresh"),
    );
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.init.headers).toMatchObject({
      authorization: "Bearer plat_1",
    });
    expect(JSON.parse(String(refreshes[0]?.init.body))).toEqual({
      refresh_token: "user_rt_1",
    });

    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        const raw = yield* store.read(agentcardConnectionRowName("user_1"));
        const serialized = JSON.stringify(raw);
        expect(serialized).not.toContain("user_at_2");
        expect(serialized).not.toContain("user_rt_2");
      }),
    );
  });

  it("replaces both encrypted tokens and preserves the connected user", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      "/api/v2/connect/verify": () => ({
        status: 200,
        body: verifiedConnection,
      }),
      "/api/v2/connect/consent": consent,
      "/api/v2/connect/refresh": () => ({
        status: 200,
        body: {
          access_token: "user_at_2",
          refresh_token: "user_rt_2",
          expires_in: 3600,
        },
      }),
    });
    const rt = connectRuntime();
    await connect(rt);

    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        const name = agentcardConnectionRowName("user_1");
        const raw = (yield* store.read(name)) as Record<string, unknown>;
        yield* store.write(name, { ...raw, expires_at: Date.now() - 1 });
      }),
    );

    const refreshed = await rt.runPromise(agentcardAccessToken());
    expect(refreshed.token).toBe("user_at_2");
    const refresh = calls.find((call) => call.url.endsWith("/connect/refresh"))!;
    expect(JSON.parse(String(refresh.init.body))).toEqual({
      refresh_token: "user_rt_1",
    });

    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        const raw = yield* store.read(agentcardConnectionRowName("user_1"));
        const serialized = JSON.stringify(raw);
        expect(serialized).not.toContain("user_at_1");
        expect(serialized).not.toContain("user_rt_1");
        expect(serialized).not.toContain("user_at_2");
        expect(serialized).not.toContain("user_rt_2");
        expect(raw).toMatchObject({
          user_id: "user_1",
          email: "owner@example.com",
        });
      }),
    );
  });

  it("does not replay a rotating refresh token after a provider 5xx", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      "/api/v2/connect/verify": () => ({
        status: 200,
        body: verifiedConnection,
      }),
      "/api/v2/connect/consent": consent,
      "/api/v2/connect/refresh": () => ({
        status: 500,
        body: {
          error: {
            code: "temporary_failure",
            message: "response was lost",
          },
        },
      }),
    });
    const rt = connectRuntime();
    await connect(rt);
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        const name = agentcardConnectionRowName("user_1");
        const raw = (yield* store.read(name)) as Record<string, unknown>;
        yield* store.write(name, { ...raw, expires_at: Date.now() - 1 });
      }),
    );

    const exit = await rt.runPromiseExit(agentcardAccessToken());
    expect(exit._tag).toBe("Failure");
    expect(calls.filter((call) => call.url.endsWith("/connect/refresh"))).toHaveLength(1);
  });
});
