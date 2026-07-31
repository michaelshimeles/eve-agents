import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireWebAuthMock } = vi.hoisted(() => ({
  requireWebAuthMock: vi.fn(),
}));

vi.mock("@/lib/web-auth", () => ({
  requireWebAuth: requireWebAuthMock,
  WEB_OWNER_PRINCIPAL_ID: "web:owner",
}));

import { authenticateWorkspaceRequest } from "./workspace-auth";

describe("workspace owner authentication", () => {
  beforeEach(() => {
    requireWebAuthMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("uses the Clerk owner and ignores the removed admin-token header", async () => {
    vi.stubEnv("VERCEL", "1");
    await expect(
      authenticateWorkspaceRequest(
        new Request("https://ruth.example/api/workspace", {
          headers: { "x-workspace-admin-token": "obsolete-secret" },
        }),
      ),
    ).resolves.toEqual({
      principalId: "web:owner",
      durableOwnershipRequired: true,
    });
  });

  it("returns the Clerk denial before workspace access", async () => {
    const denied = Response.json(
      { error: "Sign in to continue." },
      { status: 401 },
    );
    requireWebAuthMock.mockResolvedValue(denied);

    await expect(
      authenticateWorkspaceRequest(
        new Request("https://ruth.example/api/workspace", {
          headers: { "x-workspace-admin-token": "obsolete-secret" },
        }),
      ),
    ).resolves.toBe(denied);
  });

  it("still requires Clerk on loopback while skipping durable DB ownership", async () => {
    await expect(
      authenticateWorkspaceRequest(
        new Request("http://localhost:3000/api/workspace"),
      ),
    ).resolves.toEqual({
      principalId: "web:owner",
      durableOwnershipRequired: false,
    });
    expect(requireWebAuthMock).toHaveBeenCalledOnce();
  });
});
