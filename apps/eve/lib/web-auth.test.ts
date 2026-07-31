import { afterEach, describe, expect, it, vi } from "vitest";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth: authMock }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import {
  requireWebAuth,
  requireWebAuthOr,
  WEB_OWNER_PRINCIPAL_ID,
  webRequestPrincipal,
} from "./web-auth";

describe("owner web access", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    authMock.mockReset();
  });

  it("keeps the existing stable owner data scope", () => {
    expect(webRequestPrincipal()).toEqual({
      principalId: WEB_OWNER_PRINCIPAL_ID,
    });
  });

  it("allows exactly the configured Clerk owner", async () => {
    vi.stubEnv("CLERK_OWNER_USER_ID", "user_owner");
    authMock.mockResolvedValue({ userId: "user_owner" });

    await expect(
      requireWebAuth(new Request("https://ruth.example/api/files")),
    ).resolves.toBeNull();
  });

  it.each([
    [null, "user_owner", 401],
    ["user_someone_else", "user_owner", 403],
    ["user_owner", "", 503],
  ] as const)(
    "rejects user %s against owner %s with %i",
    async (userId, ownerId, status) => {
      vi.stubEnv("CLERK_OWNER_USER_ID", ownerId);
      authMock.mockResolvedValue({ userId });

      const response = await requireWebAuth(
        new Request("https://ruth.example/api/files"),
      );
      expect(response?.status).toBe(status);
      expect(response?.headers.get("cache-control")).toBe("no-store");
    },
  );

  it("keeps a route-specific admin token as an alternative", async () => {
    vi.stubEnv("CLERK_OWNER_USER_ID", "user_owner");
    authMock.mockResolvedValue({ userId: null });

    await expect(
      requireWebAuthOr(
        new Request("https://ruth.example/api/phone"),
        () => null,
      ),
    ).resolves.toBeNull();
  });
});
