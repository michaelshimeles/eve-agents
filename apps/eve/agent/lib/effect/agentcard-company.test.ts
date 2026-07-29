import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentcardStore,
  COMPANY_PENDING_ROW,
  TOKENS_ROW,
  agentcardAccessToken,
  startCompanyConnect,
  verifyCompanyConnect,
} from "./agentcard";
import { AgentcardCompanyLive } from "./agentcard-company";
import { AgentcardStoreMemory } from "./agentcard.testing";

// The company flow moves real money on the strength of these exchanges, so
// the tests pin the wire shapes: form-encoded platform grant, JSON connect
// calls under the platform bearer, rotation-on-refresh.

const API = "https://api.test";

function companyRuntime() {
  vi.stubEnv("AGENTCARD_CLIENT_ID", "cl_1");
  vi.stubEnv("AGENTCARD_CLIENT_SECRET", "acs_1");
  vi.stubEnv("AGENTCARD_OWNER_EMAIL", "owner@example.com");
  vi.stubEnv("AGENTCARD_API_URL", API);
  return ManagedRuntime.make(
    Layer.mergeAll(
      AgentcardStoreMemory,
      AgentcardCompanyLive.pipe(Layer.provide(AgentcardStoreMemory)),
    ),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Handler = (
  url: string,
  init: RequestInit,
) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

/** Routes fetch by URL suffix; records every call for assertions. */
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
  body: { access_token: "plat_1", token_type: "Bearer", expires_in: 3600, scope: "api" },
});

const userTokens = {
  object: "connection",
  access_token: "user_at_1",
  refresh_token: "user_rt_1",
  token_type: "Bearer",
  expires_in: 3600,
  user: { id: "user_1", email: "owner@example.com", phone: null },
};

const attempt = (id: string): Handler => () => ({
  status: 201,
  body: { object: "connect_attempt", id, channel: "email", expires_at: null },
});

describe("connect flow", () => {
  it("start sends the pinned email under the platform bearer, form-encodes the grant", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": () => ({
        status: 201,
        body: {
          object: "connect_attempt",
          id: "ca_1",
          channel: "email",
          expires_at: "2026-07-28T00:10:00Z",
        },
      }),
    });
    const rt = companyRuntime();
    const { expiresAt } = await rt.runPromise(startCompanyConnect());
    expect(expiresAt).toBe("2026-07-28T00:10:00Z");

    const grant = calls.find((c) => c.url.endsWith("/oauth/token"))!;
    expect(grant.init.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(String(grant.init.body)).toContain("grant_type=client_credentials");
    expect(String(grant.init.body)).toContain("client_id=cl_1");

    const start = calls.find((c) => c.url.endsWith("/connect/start"))!;
    expect(start.init.headers).toMatchObject({ authorization: "Bearer plat_1" });
    expect(JSON.parse(String(start.init.body))).toEqual({ email: "owner@example.com" });
  });

  it("verify exchanges the code, records consent, and stores a company-tagged grant", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      "/api/v2/connect/verify": () => ({ status: 200, body: userTokens }),
      "/api/v2/connect/consent": () => ({ status: 201, body: { object: "consent", id: "cns_1" } }),
    });
    const rt = companyRuntime();
    await rt.runPromise(
      Effect.gen(function* () {
        yield* startCompanyConnect();
        yield* verifyCompanyConnect("111111");
        const store = yield* AgentcardStore;
        const stored = (yield* store.read(TOKENS_ROW)) as Record<string, unknown>;
        expect(stored.mode).toBe("company");
        expect(stored.access_token).toBe("user_at_1");
        expect(stored.user_id).toBe("user_1");
        const { token } = yield* agentcardAccessToken();
        expect(token).toBe("user_at_1");
      }),
    );
    const verify = calls.find((c) => c.url.endsWith("/connect/verify"))!;
    expect(JSON.parse(String(verify.init.body))).toEqual({ connect_id: "ca_1", code: "111111" });
    const consent = calls.find((c) => c.url.endsWith("/connect/consent"))!;
    expect(JSON.parse(String(consent.init.body))).toEqual({ user_id: "user_1" });
  });

  it("verify without a pending attempt fails as authorization_state", async () => {
    stubFetch({ "/api/v2/oauth/token": platformGrant });
    const rt = companyRuntime();
    const exit = await rt.runPromiseExit(verifyCompanyConnect("111111"));
    expect(exit._tag).toBe("Failure");
  });

  it("a wrong code fails but leaves the attempt retryable: the right code then succeeds", async () => {
    stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      "/api/v2/connect/verify": (_url, init) =>
        JSON.parse(String(init.body)).code === "111111"
          ? { status: 200, body: userTokens }
          : {
              status: 401,
              body: { error: "invalid_code", error_description: "code invalid or expired" },
            },
      "/api/v2/connect/consent": () => ({ status: 201, body: { object: "consent", id: "cns_1" } }),
    });
    const rt = companyRuntime();
    const wrong = await rt.runPromiseExit(
      Effect.gen(function* () {
        yield* startCompanyConnect();
        yield* verifyCompanyConnect("000000");
      }),
    );
    expect(wrong._tag).toBe("Failure");
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        // The typo stored no grant and did not burn the pending attempt.
        expect(yield* store.read(TOKENS_ROW)).toBeNull();
        expect(yield* store.read(COMPANY_PENDING_ROW)).not.toBeNull();
        // Same attempt, right code: no new start needed.
        yield* verifyCompanyConnect("111111");
        expect(yield* store.read(TOKENS_ROW)).not.toBeNull();
        expect(yield* store.read(COMPANY_PENDING_ROW)).toBeNull();
      }),
    );
  });

  it("a newer attempt started mid-verify survives the older one's cleanup", async () => {
    const rt = companyRuntime();
    const newerPending = {
      connect_id: "ca_newer",
      started_at: Date.now(),
      expires_at: null,
    };
    stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      // While verify(ca_1) is in flight, a fresh start replaces the pending
      // row — the completed verify must not erase that newer attempt.
      "/api/v2/connect/verify": async () => {
        await rt.runPromise(
          Effect.gen(function* () {
            const store = yield* AgentcardStore;
            yield* store.write(COMPANY_PENDING_ROW, newerPending);
          }),
        );
        return { status: 200, body: userTokens };
      },
      "/api/v2/connect/consent": () => ({ status: 201, body: { object: "consent", id: "cns_1" } }),
    });
    await rt.runPromise(
      Effect.gen(function* () {
        yield* startCompanyConnect();
        yield* verifyCompanyConnect("111111");
        const store = yield* AgentcardStore;
        expect(yield* store.read(TOKENS_ROW)).not.toBeNull();
        expect(yield* store.read(COMPANY_PENDING_ROW)).toEqual(newerPending);
      }),
    );
  });

  it("an attempt the provider no longer honours is cleared for a fresh start", async () => {
    stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
      "/api/v2/connect/verify": () => ({
        status: 400,
        body: { error: "invalid_connect_attempt" },
      }),
    });
    const rt = companyRuntime();
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        yield* startCompanyConnect();
        yield* verifyCompanyConnect("111111");
      }),
    );
    expect(exit._tag).toBe("Failure");
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        expect(yield* store.read(COMPANY_PENDING_ROW)).toBeNull();
      }),
    );
  });

  it("start without AGENTCARD_OWNER_EMAIL fails as not_configured", async () => {
    stubFetch({ "/api/v2/oauth/token": platformGrant });
    const rt = companyRuntime();
    vi.stubEnv("AGENTCARD_OWNER_EMAIL", "");
    const exit = await rt.runPromiseExit(startCompanyConnect());
    expect(exit._tag).toBe("Failure");
  });
});

describe("platform token", () => {
  it("is fetched once and reused across calls", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": attempt("ca_1"),
    });
    const rt = companyRuntime();
    await rt.runPromise(startCompanyConnect());
    await rt.runPromise(startCompanyConnect());
    expect(calls.filter((c) => c.url.endsWith("/oauth/token")).length).toBe(1);
  });

  it("is invalidated and refetched once when a call answers 401 unauthorized", async () => {
    let starts = 0;
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/start": () => {
        starts += 1;
        return starts === 1
          ? { status: 401, body: { error: "unauthorized" } }
          : {
              status: 201,
              body: { object: "connect_attempt", id: "ca_2", channel: "email", expires_at: null },
            };
      },
    });
    const rt = companyRuntime();
    await rt.runPromise(startCompanyConnect());
    expect(calls.filter((c) => c.url.endsWith("/oauth/token")).length).toBe(2);
    expect(starts).toBe(2);
  });
});

describe("refresh", () => {
  const staleRow = {
    mode: "company",
    client_id: null,
    client_secret: null,
    access_token: "user_at_old",
    refresh_token: "user_rt_old",
    expires_at: Date.now() - 1000,
    connected_at: 1_700_000_000_000,
    user_id: "user_1",
    email: "owner@example.com",
  };

  it("rotates the pair through connect/refresh and keeps connected_at", async () => {
    const calls = stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/refresh": () => ({
        status: 200,
        body: { ...userTokens, access_token: "user_at_new", refresh_token: "user_rt_new" },
      }),
    });
    const rt = companyRuntime();
    const token = await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        yield* store.write(TOKENS_ROW, staleRow);
        return yield* agentcardAccessToken();
      }),
    );
    expect(token.token).toBe("user_at_new");
    const refresh = calls.find((c) => c.url.endsWith("/connect/refresh"))!;
    expect(JSON.parse(String(refresh.init.body))).toEqual({ refresh_token: "user_rt_old" });
    const stored = await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        return (yield* store.read(TOKENS_ROW)) as Record<string, unknown>;
      }),
    );
    expect(stored.refresh_token).toBe("user_rt_new");
    expect(stored.connected_at).toBe(1_700_000_000_000);
  });

  it("clears the grant and asks to reauthorize on invalid_refresh_token", async () => {
    stubFetch({
      "/api/v2/oauth/token": platformGrant,
      "/api/v2/connect/refresh": () => ({
        status: 401,
        body: { error: "invalid_refresh_token", error_description: "invalid or expired" },
      }),
    });
    const rt = companyRuntime();
    const exit = await rt.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        yield* store.write(TOKENS_ROW, staleRow);
        return yield* agentcardAccessToken();
      }),
    );
    expect(exit._tag).toBe("Failure");
    const stored = await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        return yield* store.read(TOKENS_ROW);
      }),
    );
    expect(stored).toBeNull();
  });
});
