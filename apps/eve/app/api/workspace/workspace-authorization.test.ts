import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WORKSPACE_ADMIN_HEADER } from "@/lib/workspace-api";

const mocks = vi.hoisted(() => ({
  runApp: vi.fn(),
  workspaceOverview: vi.fn(),
  writeWorkspaceText: vi.fn(),
  workspaceSessionOwnedBy: vi.fn(),
}));

vi.mock("@/agent/lib/effect/runtime", () => ({
  runApp: mocks.runApp,
}));

vi.mock("@/agent/lib/effect/sandbox-workspace", () => ({
  changeWorkspaceLifecycle: vi.fn(),
  decodeWorkspaceConfigPatch: vi.fn(),
  decodeWorkspaceForkAction: vi.fn(),
  decodeWorkspaceLifecycleAction: vi.fn(),
  decodeWorkspaceSnapshotAction: vi.fn(),
  manageWorkspaceForks: vi.fn(),
  manageWorkspaceSnapshots: vi.fn(),
  readWorkspaceFile: vi.fn(),
  readWorkspaceText: vi.fn(),
  updateWorkspaceConfig: vi.fn(),
  workspaceOverview: mocks.workspaceOverview,
  writeWorkspaceText: mocks.writeWorkspaceText,
}));

vi.mock("@/lib/dev-workspace-relay", () => ({
  devWorkspaceRelayUrl: vi.fn(async () => null),
}));

vi.mock("@/lib/threads-db", () => ({
  workspaceSessionOwnedBy: mocks.workspaceSessionOwnedBy,
}));

import { PUT as writeFile } from "./fs/content/route";
import { GET as readOverview } from "./route";

describe("workspace route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DATABASE_URL", "postgresql://test.invalid/ruth");
    vi.stubEnv("WORKSPACE_ADMIN_TOKEN", "owner-secret");
    mocks.workspaceOverview.mockReturnValue({ operation: "overview" });
    mocks.writeWorkspaceText.mockReturnValue({ operation: "write" });
    mocks.runApp.mockImplementation(async (operation: unknown) =>
      operation === (mocks.workspaceOverview.mock.results.at(-1)?.value)
        ? {
            state: "not_started",
            root: null,
            target: null,
            generations: [],
            related: [],
            sessions: [],
            snapshots: [],
            devTerminalUrl: null,
            warning: "Owner only.",
          }
        : {
            path: "/workspace/owner.txt",
            content: "owned",
            size: 5,
            modifiedAt: new Date(0).toISOString(),
            version: "version",
            mode: 0o644,
          },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stops unauthenticated reads and writes before the Sandbox boundary", async () => {
    const overview = await readOverview(
      new Request(
        "https://ruth.example/api/workspace?sessionId=victim-session",
      ),
    );
    const write = await writeFile(
      new Request("https://ruth.example/api/workspace/fs/content", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: "https://ruth.example",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          sessionId: "victim-session",
          path: "/workspace/attacker.txt",
          content: "attacker",
        }),
      }),
    );

    expect(overview.status).toBe(401);
    expect(write.status).toBe(401);
    expect(mocks.workspaceSessionOwnedBy).not.toHaveBeenCalled();
    expect(mocks.workspaceOverview).not.toHaveBeenCalled();
    expect(mocks.writeWorkspaceText).not.toHaveBeenCalled();
    expect(mocks.runApp).not.toHaveBeenCalled();
  });

  it("rejects an authenticated caller when the session is not owner-bound", async () => {
    mocks.workspaceSessionOwnedBy.mockResolvedValue(false);
    const response = await readOverview(
      new Request(
        "https://ruth.example/api/workspace?sessionId=foreign-session",
        {
          headers: { [WORKSPACE_ADMIN_HEADER]: "owner-secret" },
        },
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.workspaceSessionOwnedBy).toHaveBeenCalledWith(
      "web:owner",
      "foreign-session",
    );
    expect(mocks.workspaceOverview).not.toHaveBeenCalled();
    expect(mocks.runApp).not.toHaveBeenCalled();
  });

  it("allows an authenticated owner to reach only an owner-bound session", async () => {
    mocks.workspaceSessionOwnedBy.mockResolvedValue(true);
    const response = await readOverview(
      new Request(
        "https://ruth.example/api/workspace?sessionId=owner-session",
        {
          headers: { [WORKSPACE_ADMIN_HEADER]: "owner-secret" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.workspaceSessionOwnedBy).toHaveBeenCalledWith(
      "web:owner",
      "owner-session",
    );
    expect(mocks.workspaceOverview).toHaveBeenCalledWith(
      { sessionId: "owner-session" },
      null,
    );
    expect(mocks.runApp).toHaveBeenCalledTimes(1);
  });
});
