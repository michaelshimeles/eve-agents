import { describe, expect, it } from "vitest";

import {
  decodeWorkspaceConfigPatch,
  decodeWorkspaceForkAction,
  decodeWorkspaceFsAction,
  decodeWorkspaceLifecycleAction,
  decodeWorkspaceSnapshotAction,
  normalizeWorkspacePath,
  SandboxWorkspaceError,
  sandboxWorkspaceErrorStatus,
  sessionHash,
} from "./sandbox-workspace";

describe("sandbox workspace input boundary", () => {
  it("keeps visual paths inside /workspace", () => {
    expect(normalizeWorkspacePath("src/index.ts")).toBe("/workspace/src/index.ts");
    expect(normalizeWorkspacePath("/workspace/a/../b")).toBe("/workspace/b");
    expect(() => normalizeWorkspacePath("../outside")).toThrow(SandboxWorkspaceError);
    expect(() => normalizeWorkspacePath("/etc/passwd")).toThrow(
      "The visual workspace is limited to /workspace.",
    );
    expect(() => normalizeWorkspacePath("/workspace/hello\0world")).toThrow(
      "Workspace paths cannot contain NUL bytes.",
    );
  });

  it("uses a stable, non-reversible session lookup tag", () => {
    expect(sessionHash("session-123")).toMatch(/^[a-f0-9]{32}$/);
    expect(sessionHash("session-123")).toBe(sessionHash("session-123"));
    expect(sessionHash("session-123")).not.toBe(sessionHash("session-124"));
  });

  it("decodes valid filesystem and lifecycle operations", () => {
    expect(
      decodeWorkspaceFsAction({
        type: "rename",
        path: "/workspace/old",
        destination: "/workspace/new",
      }),
    ).toEqual({
      type: "rename",
      path: "/workspace/old",
      destination: "/workspace/new",
    });
    expect(decodeWorkspaceLifecycleAction({ type: "stop" })).toEqual({ type: "stop" });
    expect(
      decodeWorkspaceSnapshotAction({ type: "create", expirationMs: 0 }),
    ).toEqual({ type: "create", expirationMs: 0 });
    expect(decodeWorkspaceForkAction({ type: "create", label: "experiment" })).toEqual({
      type: "create",
      label: "experiment",
    });
  });

  it("rejects malformed or excessive operations before they reach the provider", () => {
    expect(() =>
      decodeWorkspaceFsAction({ type: "chmod", path: "/workspace/file", mode: 0o10000 }),
    ).toThrow("The workspace request is invalid.");
    expect(() =>
      decodeWorkspaceLifecycleAction({ type: "reset", confirmation: "sandbox" }),
    ).toThrow("The workspace request is invalid.");
    expect(() =>
      decodeWorkspaceSnapshotAction({ type: "delete", snapshotId: "" }),
    ).toThrow("The workspace request is invalid.");
    expect(() =>
      decodeWorkspaceForkAction({ type: "create", label: "x".repeat(129) }),
    ).toThrow("The workspace request is invalid.");
  });

  it("validates configuration bounds and unique ports", () => {
    expect(
      decodeWorkspaceConfigPatch({
        vcpus: 4,
        timeoutMs: 600_000,
        persistent: true,
        ports: [3000, 5173],
        keepLastSnapshots: { count: 5, deleteEvicted: true },
        networkPolicy: {
          mode: "custom",
          allowedDomains: ["api.example.com"],
          allowedCidrs: [],
          deniedCidrs: ["10.0.0.0/8"],
        },
      }),
    ).toMatchObject({
      vcpus: 4,
      ports: [3000, 5173],
      networkPolicy: { mode: "custom", allowedDomains: ["api.example.com"] },
    });
    expect(() => decodeWorkspaceConfigPatch({ ports: [3000, 3000] })).toThrow(
      "Ports must be unique.",
    );
    expect(() => decodeWorkspaceConfigPatch({ vcpus: 0 })).toThrow(
      "The workspace request is invalid.",
    );
    expect(() =>
      decodeWorkspaceConfigPatch({
        networkPolicy: {
          mode: "custom",
          allowedDomains: "api.example.com",
          allowedCidrs: [],
          deniedCidrs: [],
        },
      }),
    ).toThrow("The workspace request is invalid.");
  });

  it("maps typed service errors to stable API statuses", () => {
    expect(
      sandboxWorkspaceErrorStatus(
        new SandboxWorkspaceError({
          kind: "credentials",
          message: "missing credentials",
          operation: "open",
        }),
      ),
    ).toBe(503);
    expect(
      sandboxWorkspaceErrorStatus(
        new SandboxWorkspaceError({
          kind: "conflict",
          message: "changed",
          operation: "save",
        }),
      ),
    ).toBe(409);
  });
});
