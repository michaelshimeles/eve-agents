import { afterEach, describe, expect, it, vi } from "vitest";

import { CARD_ADMIN_HEADER, cardAuthState, requireCardAdmin } from "./card-auth";

// This gate is what stands between a public deployment and a stranger
// consuming (or spamming) the owner's emailed connect codes. The deep
// negative cases live in phone-auth.test.ts against the same shared rules;
// these pin the card instantiation: its env var, header, and fail-closed
// default.

afterEach(() => {
  vi.unstubAllEnvs();
});

const PUBLIC = "https://ruth.example.com/api/agentcard/connect/start";
const LOCAL = "http://localhost:3000/api/agentcard/connect/start";

function req(
  url: string,
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
): Request {
  return new Request(url, { method: "POST", headers });
}

describe("requireCardAdmin", () => {
  it("fails closed on a public deployment with no token configured", () => {
    vi.stubEnv("AGENTCARD_ADMIN_TOKEN", "");
    expect(requireCardAdmin(req(PUBLIC))?.status).toBe(503);
  });

  it("allows loopback with no token, so local development still works", () => {
    vi.stubEnv("AGENTCARD_ADMIN_TOKEN", "");
    expect(requireCardAdmin(req(LOCAL))).toBeNull();
  });

  it("accepts the configured token and rejects a wrong one", () => {
    vi.stubEnv("AGENTCARD_ADMIN_TOKEN", "s3cret");
    expect(
      requireCardAdmin(
        req(PUBLIC, { "sec-fetch-site": "same-origin", [CARD_ADMIN_HEADER]: "s3cret" }),
      ),
    ).toBeNull();
    expect(
      requireCardAdmin(
        req(PUBLIC, { "sec-fetch-site": "same-origin", [CARD_ADMIN_HEADER]: "wrong" }),
      )?.status,
    ).toBe(401);
  });

  it("rejects cross-site callers before it ever looks at the token", () => {
    vi.stubEnv("AGENTCARD_ADMIN_TOKEN", "s3cret");
    expect(
      requireCardAdmin(
        req(PUBLIC, { "sec-fetch-site": "cross-site", [CARD_ADMIN_HEADER]: "s3cret" }),
      )?.status,
    ).toBe(403);
  });
});

describe("cardAuthState", () => {
  it("reports that a public deployment needs a token", () => {
    vi.stubEnv("AGENTCARD_ADMIN_TOKEN", "");
    expect(cardAuthState(req(PUBLIC))).toEqual({ authRequired: true, authConfigured: false });
  });

  it("reports that loopback without a token does not", () => {
    vi.stubEnv("AGENTCARD_ADMIN_TOKEN", "");
    expect(cardAuthState(req(LOCAL))).toEqual({ authRequired: false, authConfigured: false });
  });
});
