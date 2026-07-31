import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IMESSAGE_ADMIN_HEADER,
  imessageTranscriptAuthState,
  requireIMessageTranscriptAdmin,
} from "./imessage-auth";

afterEach(() => {
  vi.unstubAllEnvs();
});

const PUBLIC = "https://ruth.example.com/api/imessage/transcript";
const LOCAL = "http://localhost:3000/api/imessage/transcript";

function req(
  url: string,
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
): Request {
  return new Request(url, { headers });
}

describe("requireIMessageTranscriptAdmin", () => {
  it("fails closed on a public deployment with no token configured", () => {
    vi.stubEnv("IMESSAGE_ADMIN_TOKEN", "");
    expect(requireIMessageTranscriptAdmin(req(PUBLIC))?.status).toBe(503);
  });

  it("allows tokenless loopback development but never a Vercel runtime", () => {
    vi.stubEnv("IMESSAGE_ADMIN_TOKEN", "");
    expect(requireIMessageTranscriptAdmin(req(LOCAL))).toBeNull();

    vi.stubEnv("VERCEL", "1");
    expect(requireIMessageTranscriptAdmin(req(LOCAL))?.status).toBe(503);
  });

  it("accepts the configured token and rejects missing or wrong tokens", () => {
    vi.stubEnv("IMESSAGE_ADMIN_TOKEN", "correct horse battery staple");
    expect(
      requireIMessageTranscriptAdmin(
        req(PUBLIC, {
          "sec-fetch-site": "same-origin",
          [IMESSAGE_ADMIN_HEADER]: "correct horse battery staple",
        }),
      ),
    ).toBeNull();
    expect(requireIMessageTranscriptAdmin(req(PUBLIC))?.status).toBe(401);
    expect(
      requireIMessageTranscriptAdmin(
        req(PUBLIC, {
          "sec-fetch-site": "same-origin",
          [IMESSAGE_ADMIN_HEADER]: "wrong",
        }),
      )?.status,
    ).toBe(401);
  });

  it("rejects cross-site and non-browser requests even with the token", () => {
    vi.stubEnv("IMESSAGE_ADMIN_TOKEN", "secret");
    expect(
      requireIMessageTranscriptAdmin(
        req(PUBLIC, {
          "sec-fetch-site": "cross-site",
          [IMESSAGE_ADMIN_HEADER]: "secret",
        }),
      )?.status,
    ).toBe(403);
    expect(
      requireIMessageTranscriptAdmin(
        new Request(PUBLIC, {
          headers: { [IMESSAGE_ADMIN_HEADER]: "secret" },
        }),
      )?.status,
    ).toBe(403);
  });
});

describe("imessageTranscriptAuthState", () => {
  it("reports whether the current deployment can be unlocked", () => {
    vi.stubEnv("IMESSAGE_ADMIN_TOKEN", "");
    expect(imessageTranscriptAuthState(req(PUBLIC))).toEqual({
      authRequired: true,
      authConfigured: false,
    });
    expect(imessageTranscriptAuthState(req(LOCAL))).toEqual({
      authRequired: false,
      authConfigured: false,
    });

    vi.stubEnv("IMESSAGE_ADMIN_TOKEN", "secret");
    expect(imessageTranscriptAuthState(req(PUBLIC))).toEqual({
      authRequired: true,
      authConfigured: true,
    });
  });
});
