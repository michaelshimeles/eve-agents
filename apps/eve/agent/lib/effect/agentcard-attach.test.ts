import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentcardStore,
  agentcardAttachmentStatus,
  fundAgentcardWallet,
  recordAgentcardConsent,
  startAgentcardAttachment,
  startAgentcardPhoneVerification,
  verifyAgentcardPhone,
} from "./agentcard";
import { AgentcardConnectLive } from "./agentcard-connect";
import { AgentcardStoreMemory } from "./agentcard.testing";

const API = "https://api.test";

function runtime() {
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

async function seedConnected(
  rt: ReturnType<typeof runtime>,
  phone: string | null = null,
): Promise<void> {
  await rt.runPromise(
    Effect.gen(function* () {
      const store = yield* AgentcardStore;
      yield* store.write("tokens", {
        mode: "company",
        access_token: "user_at_1",
        refresh_token: "user_rt_1",
        expires_at: Date.now() + 3_600_000,
        connected_at: Date.now(),
        user_id: "user_1",
        email: "owner@example.com",
        phone,
      });
    }),
  );
}

type Handler = (request: {
  readonly url: URL;
  readonly init: RequestInit;
}) =>
  | { readonly status: number; readonly body: unknown }
  | Promise<{ readonly status: number; readonly body: unknown }>;

function stubFetch(handlers: Record<string, Handler>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    const handler = handlers[key];
    if (handler === undefined) throw new Error(`unexpected fetch: ${key}`);
    const result = await handler({ url, init });
    return new Response(JSON.stringify(result.body), { status: result.status });
  });
  return calls;
}

const platformGrant: Handler = () => ({
  status: 200,
  body: { access_token: "plat_1" },
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Agentcard card attachment", () => {
  it("starts with the encrypted connection's user id and returns only the hosted link", async () => {
    const expiresAt = "2026-07-31T12:00:00.000Z";
    const calls = stubFetch({
      "POST /api/v2/oauth/token": platformGrant,
      "POST /api/v2/attach": () => ({
        status: 201,
        body: {
          object: "card_attachment",
          id: "att_secret",
          user_id: "user_1",
          status: "pending",
          attach_url: "https://agentcard.sh/attach/safe-link",
          expires_at: expiresAt,
        },
      }),
    });
    const rt = runtime();
    await seedConnected(rt);

    await expect(rt.runPromise(startAgentcardAttachment())).resolves.toEqual({
      status: "pending",
      attachUrl: "https://agentcard.sh/attach/safe-link",
      expiresAt,
    });

    const attach = calls.find((call) => call.url.pathname === "/api/v2/attach")!;
    expect(attach.init.headers).toMatchObject({
      authorization: "Bearer plat_1",
    });
    expect(JSON.parse(String(attach.init.body))).toEqual({
      user_id: "user_1",
    });
  });

  it("recognizes an already-active card without starting another attachment", async () => {
    stubFetch({
      "POST /api/v2/oauth/token": platformGrant,
      "POST /api/v2/attach": () => ({
        status: 200,
        body: {
          status: "active",
          card: { brand: "Visa", last4: "4242" },
        },
      }),
    });
    const rt = runtime();
    await seedConnected(rt);

    await expect(rt.runPromise(startAgentcardAttachment())).resolves.toEqual({
      status: "active",
      card: { brand: "Visa", last4: "4242" },
    });
  });

  it("checks pending, active, and ineligible status over GET with an encoded user id", async () => {
    let checks = 0;
    const calls = stubFetch({
      "POST /api/v2/oauth/token": platformGrant,
      "GET /api/v2/attach": () => {
        checks += 1;
        if (checks === 1) return { status: 200, body: { status: "pending" } };
        if (checks === 2) {
          return {
            status: 200,
            body: {
              status: "active",
              card: { brand: "Visa", last4: "1111" },
            },
          };
        }
        return {
          status: 200,
          body: {
            status: "ineligible",
            reason: "commercial_card",
            message: "Business cards cannot be attached.",
          },
        };
      },
    });
    const rt = runtime();
    await seedConnected(rt);

    await expect(rt.runPromise(agentcardAttachmentStatus())).resolves.toEqual({
      status: "pending",
    });
    await expect(rt.runPromise(agentcardAttachmentStatus())).resolves.toEqual({
      status: "active",
      card: { brand: "Visa", last4: "1111" },
    });
    await expect(rt.runPromise(agentcardAttachmentStatus())).resolves.toEqual({
      status: "ineligible",
      reason: "commercial_card",
      message: "Business cards cannot be attached.",
    });
    expect(
      calls
        .filter((call) => call.url.pathname === "/api/v2/attach")
        .every((call) => call.url.searchParams.get("user_id") === "user_1"),
    ).toBe(true);
  });

  it("branches on no_attachment, user_info_required, and attach_unavailable", async () => {
    let starts = 0;
    stubFetch({
      "POST /api/v2/oauth/token": platformGrant,
      "GET /api/v2/attach": () => ({
        status: 404,
        body: {
          error: {
            code: "no_attachment",
            message: "Nothing was started.",
          },
        },
      }),
      "POST /api/v2/attach": () => {
        starts += 1;
        return starts === 1
          ? {
              status: 422,
              body: {
                error: {
                  code: "user_info_required",
                  message: "Complete prerequisites.",
                  missing_fields: ["phone_number", "consent"],
                },
              },
            }
          : {
              status: 503,
              body: {
                error: {
                  code: "attach_unavailable",
                  message: "Attachment is off right now.",
                },
              },
            };
      },
    });
    const rt = runtime();
    await seedConnected(rt);

    await expect(rt.runPromise(agentcardAttachmentStatus())).resolves.toEqual({
      status: "no_attachment",
    });
    await expect(rt.runPromise(startAgentcardAttachment())).resolves.toEqual({
      status: "user_info_required",
      missingFields: ["phone_number", "consent"],
      message: "Complete prerequisites.",
    });
    await expect(rt.runPromise(startAgentcardAttachment())).resolves.toEqual({
      status: "unavailable",
      message: "Attachment is off right now.",
    });
  });

  it("handles phone verification, consent, and hosted wallet fallback under the platform token", async () => {
    const calls = stubFetch({
      "POST /api/v2/oauth/token": platformGrant,
      "POST /api/v2/wallet/phone/start": () => ({
        status: 200,
        body: {
          status: "sent",
          channel: "sms",
          phone: "+1••••0123",
          expires_in_seconds: 600,
        },
      }),
      "POST /api/v2/wallet/phone/verify": () => ({
        status: 200,
        body: { status: "verified" },
      }),
      "POST /api/v2/connect/consent": () => ({
        status: 201,
        body: { object: "consent", id: "cns_1" },
      }),
      "POST /api/v2/wallet/fund": () => ({
        status: 201,
        body: {
          checkout_url: "https://api.agentcard.sh/fund/fund_1",
          expires_at: "2026-07-29T13:00:00.000Z",
          amount_cents: 2500,
          payment_method: "apple_pay",
        },
      }),
    });
    const rt = runtime();
    await seedConnected(rt);

    await expect(
      rt.runPromise(
        startAgentcardPhoneVerification({ phoneNumber: "+14165550123" }),
      ),
    ).resolves.toEqual({
      status: "sent",
      channel: "sms",
      phone: "+1••••0123",
      expiresInSeconds: 600,
    });
    await rt.runPromise(
      verifyAgentcardPhone({
        code: "111111",
        phoneNumber: "+14165550123",
      }),
    );
    await rt.runPromise(recordAgentcardConsent());
    await expect(
      rt.runPromise(
        fundAgentcardWallet({
          amountCents: 2500,
          paymentMethod: "apple_pay",
        }),
      ),
    ).resolves.toMatchObject({
      checkoutUrl: "https://api.agentcard.sh/fund/fund_1",
      amountCents: 2500,
      paymentMethod: "apple_pay",
    });

    const bodies = Object.fromEntries(
      calls
        .filter((call) => call.url.pathname !== "/api/v2/oauth/token")
        .map((call) => [
          call.url.pathname,
          JSON.parse(String(call.init.body)),
        ]),
    );
    expect(bodies).toMatchObject({
      "/api/v2/wallet/phone/start": {
        user_id: "user_1",
        phone_number: "+14165550123",
      },
      "/api/v2/wallet/phone/verify": {
        user_id: "user_1",
        code: "111111",
        phone_number: "+14165550123",
      },
      "/api/v2/connect/consent": {
        user_id: "user_1",
      },
      "/api/v2/wallet/fund": {
        user_id: "user_1",
        amount_cents: 2500,
        payment_method: "apple_pay",
        link_type: "hosted",
      },
    });
  });

  it("refuses to relay a non-HTTPS provider link outside loopback development", async () => {
    stubFetch({
      "POST /api/v2/oauth/token": platformGrant,
      "POST /api/v2/attach": () => ({
        status: 201,
        body: {
          status: "pending",
          attach_url: "http://attacker.example/collect-card",
          expires_at: "2026-07-31T12:00:00.000Z",
        },
      }),
    });
    const rt = runtime();
    await seedConnected(rt);

    const exit = await rt.runPromiseExit(startAgentcardAttachment());
    expect(exit._tag).toBe("Failure");
  });
});
