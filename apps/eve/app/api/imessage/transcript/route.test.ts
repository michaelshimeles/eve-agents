import { afterEach, describe, expect, it, vi } from "vitest";

import { IMESSAGE_ADMIN_HEADER } from "@/lib/imessage-auth";

import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

const URL = "https://ruth.example.com/api/imessage/transcript";

describe("GET /api/imessage/transcript", () => {
  it("rejects a public request before reading the database when no token is configured", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://must-not-be-contacted");
    vi.stubEnv("IMESSAGE_ADMIN_TOKEN", "");
    const response = await GET(
      new Request(URL, { headers: { "sec-fetch-site": "same-origin" } }),
    );
    expect(response.status).toBe(503);
  });

  it("rejects a missing token before reading the database", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://must-not-be-contacted");
    vi.stubEnv("IMESSAGE_ADMIN_TOKEN", "secret");
    const response = await GET(
      new Request(URL, { headers: { "sec-fetch-site": "same-origin" } }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a cross-site request even when it presents the token", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://must-not-be-contacted");
    vi.stubEnv("IMESSAGE_ADMIN_TOKEN", "secret");
    const response = await GET(
      new Request(URL, {
        headers: {
          "sec-fetch-site": "cross-site",
          [IMESSAGE_ADMIN_HEADER]: "secret",
        },
      }),
    );
    expect(response.status).toBe(403);
  });
});
