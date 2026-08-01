import { describe, expect, it, vi } from "vitest";

import { createEveClerkHeaders } from "./eve-auth-client";

describe("Eve Clerk request headers", () => {
  it("resolves a fresh bearer token for every request", async () => {
    const getToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("refreshed");
    const headers = createEveClerkHeaders(getToken);

    await expect(headers()).resolves.toEqual({ authorization: "Bearer first" });
    await expect(headers()).resolves.toEqual({ authorization: "Bearer refreshed" });
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("fails clearly when Clerk no longer has a signed-in session", async () => {
    const headers = createEveClerkHeaders(async () => null);

    await expect(headers()).rejects.toThrow("sign-in session is no longer available");
  });
});
