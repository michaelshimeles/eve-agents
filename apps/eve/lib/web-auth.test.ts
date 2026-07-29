import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticateWebRequest,
  WEB_OWNER_PRINCIPAL_ID,
} from "./web-auth";

function productionRequest(authorization?: string): Request {
  return new Request("https://ruth.example/api/files", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("authenticateWebRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed on a deployment without owner credentials", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_AUTH_USERNAME", "");
    vi.stubEnv("WEB_AUTH_PASSWORD", "");

    const result = authenticateWebRequest(productionRequest());

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
  });

  it("challenges missing or incorrect production credentials", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_AUTH_USERNAME", "owner");
    vi.stubEnv("WEB_AUTH_PASSWORD", "correct horse");

    for (const authorization of [
      undefined,
      basic("owner", "wrong battery"),
    ]) {
      const result = authenticateWebRequest(
        productionRequest(authorization),
      );
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
      expect((result as Response).headers.get("www-authenticate")).toBe(
        'Basic realm="Ruth", charset="UTF-8"',
      );
    }
  });

  it("returns the stable owner principal after verifying Basic auth", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_AUTH_USERNAME", "owner");
    vi.stubEnv("WEB_AUTH_PASSWORD", "correct horse");

    expect(
      authenticateWebRequest(
        productionRequest(basic("owner", "correct horse")),
      ),
    ).toEqual({ principalId: WEB_OWNER_PRINCIPAL_ID });
  });

  it("allows direct loopback development but not forwarded loopback traffic", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WEB_AUTH_USERNAME", "");
    vi.stubEnv("WEB_AUTH_PASSWORD", "");

    expect(
      authenticateWebRequest(new Request("http://127.0.0.1/api/files")),
    ).toEqual({ principalId: WEB_OWNER_PRINCIPAL_ID });

    const forwarded = authenticateWebRequest(
      new Request("http://127.0.0.1/api/files", {
        headers: { "x-forwarded-for": "203.0.113.5" },
      }),
    );
    expect(forwarded).toBeInstanceOf(Response);
    expect((forwarded as Response).status).toBe(503);
  });
});
