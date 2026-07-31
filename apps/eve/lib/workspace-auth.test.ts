import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_ADMIN_HEADER,
} from "@/lib/workspace-api";

import {
  authenticateWorkspaceRequest,
  createWorkspaceLoginResponse,
  WORKSPACE_AUTH_COOKIE,
} from "./workspace-auth";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workspace owner authentication", () => {
  it("fails closed on public deployments without a configured token", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("WORKSPACE_ADMIN_TOKEN", "");
    const result = authenticateWorkspaceRequest(
      new Request("https://ruth.example/api/workspace"),
    );

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      authRequired: true,
      authConfigured: false,
    });
  });

  it("rejects unauthenticated public callers and accepts the configured owner", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("WORKSPACE_ADMIN_TOKEN", "correct horse battery staple");

    const missing = authenticateWorkspaceRequest(
      new Request("https://ruth.example/api/workspace"),
    );
    expect(missing).toBeInstanceOf(Response);
    expect((missing as Response).status).toBe(401);

    const owner = authenticateWorkspaceRequest(
      new Request("https://ruth.example/api/workspace", {
        headers: {
          [WORKSPACE_ADMIN_HEADER]: "correct horse battery staple",
        },
      }),
    );
    expect(owner).toEqual({
      principalId: "web:owner",
      durableOwnershipRequired: true,
    });
  });

  it("exchanges the raw token for a scoped HttpOnly cookie", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("WORKSPACE_ADMIN_TOKEN", "correct horse battery staple");
    const login = createWorkspaceLoginResponse(
      new Request("https://ruth.example/api/workspace/auth", {
        method: "POST",
        headers: {
          "sec-fetch-site": "same-origin",
          [WORKSPACE_ADMIN_HEADER]: "correct horse battery staple",
        },
      }),
    );

    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${WORKSPACE_AUTH_COOKIE}=v1.`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toContain("correct horse battery staple");

    const cookie = setCookie.split(";")[0];
    expect(
      authenticateWorkspaceRequest(
        new Request("https://ruth.example/api/workspace", {
          headers: { cookie },
        }),
      ),
    ).toEqual({
      principalId: "web:owner",
      durableOwnershipRequired: true,
    });
  });

  it("does not let a cross-site page exchange an owner token", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("WORKSPACE_ADMIN_TOKEN", "secret");
    const response = createWorkspaceLoginResponse(
      new Request("https://ruth.example/api/workspace/auth", {
        method: "POST",
        headers: {
          "sec-fetch-site": "cross-site",
          [WORKSPACE_ADMIN_HEADER]: "secret",
        },
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
