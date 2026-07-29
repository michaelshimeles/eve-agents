import { afterEach, describe, expect, it, vi } from "vitest";

import { PHONE_ADMIN_HEADER, phoneAdminConfigured, phoneAuthState, requirePhoneAdmin } from "./phone-auth";

// This gate is what stands between a public deployment and someone buying
// numbers on the owner's card, so every negative case is load-bearing.

afterEach(() => {
  vi.unstubAllEnvs();
});

const PUBLIC = "https://ruth.example.com/api/phone";
const LOCAL = "http://localhost:3000/api/phone";

function req(
  url: string,
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
): Request {
  return new Request(url, { method: "POST", headers });
}

describe("requirePhoneAdmin", () => {
  it("fails closed on a public deployment with no token configured", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "");
    const denied = requirePhoneAdmin(req(PUBLIC));
    expect(denied?.status).toBe(503);
  });

  it("allows loopback with no token, so local development still works", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "");
    expect(requirePhoneAdmin(req(LOCAL))).toBeNull();
  });

  it("never treats a Vercel deployment as loopback, whatever the URL says", () => {
    // A serverless runtime can hand the handler an internal localhost origin;
    // trusting it there would unlock the panel for the whole internet.
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "");
    vi.stubEnv("VERCEL", "1");
    expect(requirePhoneAdmin(req(LOCAL))?.status).toBe(503);
    expect(phoneAuthState(req(LOCAL)).authRequired).toBe(true);
  });

  it("never treats a production build as loopback", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(requirePhoneAdmin(req(LOCAL))?.status).toBe(503);
  });

  it("does not treat a forwarded request as loopback", () => {
    // A proxied request carries x-forwarded-for, so a Host of localhost must
    // not buy it local trust.
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "");
    const denied = requirePhoneAdmin(
      req(LOCAL, { "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.9" }),
    );
    expect(denied?.status).toBe(503);
  });

  it("accepts the configured token", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "s3cret");
    const allowed = requirePhoneAdmin(
      req(PUBLIC, { "sec-fetch-site": "same-origin", [PHONE_ADMIN_HEADER]: "s3cret" }),
    );
    expect(allowed).toBeNull();
  });

  it("rejects a wrong or missing token with 401", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "s3cret");
    expect(requirePhoneAdmin(req(PUBLIC))?.status).toBe(401);
    expect(
      requirePhoneAdmin(req(PUBLIC, { "sec-fetch-site": "same-origin", [PHONE_ADMIN_HEADER]: "" }))
        ?.status,
    ).toBe(401);
    expect(
      requirePhoneAdmin(
        req(PUBLIC, { "sec-fetch-site": "same-origin", [PHONE_ADMIN_HEADER]: "wrong" }),
      )?.status,
    ).toBe(401);
  });

  it("still requires the token on loopback once one is configured", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "s3cret");
    expect(requirePhoneAdmin(req(LOCAL))?.status).toBe(401);
  });

  it("rejects a token of the wrong length without throwing", () => {
    // The comparison hashes first, so timingSafeEqual never sees mismatched
    // buffer lengths.
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "s3cret");
    expect(() =>
      requirePhoneAdmin(
        req(PUBLIC, { "sec-fetch-site": "same-origin", [PHONE_ADMIN_HEADER]: "x" }),
      ),
    ).not.toThrow();
  });

  it("rejects cross-site callers before it ever looks at the token", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "s3cret");
    const denied = requirePhoneAdmin(
      req(PUBLIC, { "sec-fetch-site": "cross-site", [PHONE_ADMIN_HEADER]: "s3cret" }),
    );
    expect(denied?.status).toBe(403);
  });

  it("rejects a scripted call that sends no Sec-Fetch-Site at all", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "s3cret");
    const denied = requirePhoneAdmin(new Request(PUBLIC, { method: "POST" }));
    expect(denied?.status).toBe(403);
  });
});

describe("phoneAuthState", () => {
  it("reports that a public deployment needs a token", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "");
    expect(phoneAuthState(req(PUBLIC))).toEqual({ authRequired: true, authConfigured: false });
  });

  it("reports that loopback without a token does not", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "");
    expect(phoneAuthState(req(LOCAL))).toEqual({ authRequired: false, authConfigured: false });
  });

  it("reports a configured token everywhere, including loopback", () => {
    vi.stubEnv("AGENTPHONE_ADMIN_TOKEN", "s3cret");
    expect(phoneAuthState(req(LOCAL))).toEqual({ authRequired: true, authConfigured: true });
    expect(phoneAdminConfigured()).toBe(true);
  });
});
