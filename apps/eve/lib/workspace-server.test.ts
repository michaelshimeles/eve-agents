import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxWorkspaceError } from "@/agent/lib/effect/sandbox-workspace";
import { WORKSPACE_ADMIN_HEADER } from "@/lib/workspace-api";

import {
  requireWorkspaceRequest,
  workspaceApiFailure,
  workspaceSocketUrl,
  workspaceTargetFromBody,
  workspaceTargetFromUrl,
} from "./workspace-server";

describe("workspace server boundary", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("WORKSPACE_ADMIN_TOKEN", "workspace-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses a selected session and optional sandbox target", () => {
    expect(
      workspaceTargetFromUrl(
        new URL(
          "https://ruth.example/api/workspace?sessionId=session-1&targetName=sandbox-1",
        ),
      ),
    ).toEqual({ sessionId: "session-1", targetName: "sandbox-1" });
    expect(workspaceTargetFromBody({ sessionId: "session-2" })).toEqual({
      sessionId: "session-2",
    });
  });

  it("rejects missing or oversized target identifiers", () => {
    expect(() =>
      workspaceTargetFromUrl(new URL("https://ruth.example/api/workspace")),
    ).toThrow("A valid Eve sessionId is required.");
    expect(() =>
      workspaceTargetFromBody({
        sessionId: "session",
        targetName: "x".repeat(129),
      }),
    ).toThrow("The workspace target name is invalid.");
  });

  it("upgrades HTTPS URLs to secure WebSocket URLs", () => {
    expect(
      workspaceSocketUrl(new Request("https://ruth.example/api/workspace/terminal"))
        .toString(),
    ).toBe("wss://ruth.example/api/workspace/terminal");
  });

  it("accepts proxied same-origin browser mutations and rejects cross-site ones", async () => {
    const sameOrigin = requireWorkspaceRequest(
      new Request("http://internal-host/api/workspace", {
        method: "POST",
        headers: {
          Origin: "https://ruth.example",
          "Sec-Fetch-Site": "same-origin",
          [WORKSPACE_ADMIN_HEADER]: "workspace-secret",
        },
      }),
      true,
    );
    expect(sameOrigin).toEqual({
      principalId: "web:owner",
      durableOwnershipRequired: true,
    });

    const crossSite = requireWorkspaceRequest(
      new Request("https://ruth.example/api/workspace", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Sec-Fetch-Site": "cross-site",
          [WORKSPACE_ADMIN_HEADER]: "workspace-secret",
        },
      }),
      true,
    );
    expect(crossSite).toBeInstanceOf(Response);
    const crossSiteResponse = crossSite as Response;
    expect(crossSiteResponse.status).toBe(403);
    await expect(crossSiteResponse.json()).resolves.toEqual({
      error: "Cross-origin workspace requests are not allowed.",
    });
  });

  it("rejects public workspace requests without owner authentication", async () => {
    const denied = requireWorkspaceRequest(
      new Request("https://ruth.example/api/workspace?sessionId=victim-session"),
    );
    expect(denied).toBeInstanceOf(Response);
    const response = denied as Response;
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      authRequired: true,
      authConfigured: true,
    });
  });

  it("does not expose provider errors in HTTP responses", async () => {
    const response = workspaceApiFailure(
      new Error("Could not get credentials from OIDC context: secret internals"),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Vercel Sandbox credentials are not available for this deployment.",
    });

    const providerResponse = workspaceApiFailure(
      new SandboxWorkspaceError({
        kind: "provider",
        operation: "list workspaces",
        message: "Provider returned a secret diagnostic.",
      }),
    );
    expect(providerResponse.status).toBe(502);
    await expect(providerResponse.json()).resolves.toEqual({
      error: "Workspace request failed.",
    });
  });

  it("preserves safe tagged domain errors and their HTTP status", async () => {
    const response = workspaceApiFailure(
      new SandboxWorkspaceError({
        kind: "conflict",
        operation: "write file",
        message: "The file changed after it was opened.",
      }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The file changed after it was opened.",
    });
  });
});
