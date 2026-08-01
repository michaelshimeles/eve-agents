import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => {
  const deletedSnapshot = vi.fn(async () => undefined);
  const liveSandbox = {
    name: "sandbox-a",
    status: "stopped",
    currentSnapshotId: "snapshot-current",
    listSnapshots: vi.fn(),
    update: vi.fn(async () => undefined),
  };
  return {
    deletedSnapshot,
    liveSandbox,
    list: vi.fn(),
    get: vi.fn(),
    getSnapshot: vi.fn(),
  };
});

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    list: provider.list,
    get: provider.get,
  },
  Snapshot: {
    get: provider.getSnapshot,
  },
}));

import {
  manageWorkspaceSnapshots,
  SandboxWorkspaceError,
  SandboxWorkspaceLive,
} from "./sandbox-workspace";

function paginator<T>(items: T[]) {
  return { toArray: async () => items };
}

function snapshotPaginator<T>(pages: T[][]) {
  return {
    toArray: async () => pages.flat(),
    async *pages() {
      for (const [index, snapshots] of pages.entries()) {
        yield {
          snapshots,
          pagination: {
            count: snapshots.length,
            next: index + 1 < pages.length ? `page-${index + 2}` : null,
          },
        };
      }
    },
  };
}

const listedSandbox = {
  name: "sandbox-a",
  persistent: true,
  createdAt: 1,
  updatedAt: 1,
  currentSessionId: "provider-session",
  status: "stopped",
  currentSnapshotId: "snapshot-current",
  tags: { sessionId: "eve-session" },
};

describe("sandbox workspace snapshot ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.list.mockImplementation(async ({ tags }: { tags: Record<string, string> }) =>
      paginator("sessionId" in tags ? [listedSandbox] : []),
    );
    provider.get.mockResolvedValue(provider.liveSandbox);
    provider.liveSandbox.listSnapshots.mockResolvedValue(
      snapshotPaginator([
        [
          {
            id: "snapshot-owned",
            status: "created",
          },
        ],
      ]),
    );
    provider.getSnapshot.mockResolvedValue({
      delete: provider.deletedSnapshot,
    });
  });

  it("rejects a foreign snapshot before global lookup or deletion", async () => {
    const result = await Effect.runPromiseExit(
      manageWorkspaceSnapshots(
        { sessionId: "eve-session" },
        {
          type: "delete",
          snapshotId: "snapshot-foreign",
          confirmation: "sandbox-a",
        },
      ).pipe(Effect.provide(SandboxWorkspaceLive)),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const failure = result.cause.reasons.find(
        (reason) => reason._tag === "Fail",
      );
      expect(failure?._tag).toBe("Fail");
      if (failure?._tag === "Fail") {
        expect(failure.error).toBeInstanceOf(SandboxWorkspaceError);
        expect(failure.error).toMatchObject({
          kind: "not_found",
          operation: "manage the snapshot",
        });
      }
    }
    expect(provider.getSnapshot).not.toHaveBeenCalled();
    expect(provider.deletedSnapshot).not.toHaveBeenCalled();
  });

  it("deletes a snapshot only after the selected sandbox lists it", async () => {
    await Effect.runPromise(
      manageWorkspaceSnapshots(
        { sessionId: "eve-session" },
        {
          type: "delete",
          snapshotId: "snapshot-owned",
          confirmation: "sandbox-a",
        },
      ).pipe(Effect.provide(SandboxWorkspaceLive)),
    );

    expect(provider.liveSandbox.listSnapshots).toHaveBeenCalledOnce();
    expect(provider.getSnapshot).toHaveBeenCalledWith({
      snapshotId: "snapshot-owned",
    });
    expect(provider.deletedSnapshot).toHaveBeenCalledOnce();
  });

  it("finds owned delete and rollback snapshots after the first provider page", async () => {
    provider.liveSandbox.listSnapshots.mockResolvedValue(
      snapshotPaginator([
        Array.from({ length: 50 }, (_, index) => ({
          id: `snapshot-newer-${index}`,
          status: "created",
        })),
        [
          {
            id: "snapshot-owned-older",
            status: "created",
          },
        ],
      ]),
    );

    await Effect.runPromise(
      manageWorkspaceSnapshots(
        { sessionId: "eve-session" },
        {
          type: "delete",
          snapshotId: "snapshot-owned-older",
          confirmation: "sandbox-a",
        },
      ).pipe(Effect.provide(SandboxWorkspaceLive)),
    );
    await Effect.runPromise(
      manageWorkspaceSnapshots(
        { sessionId: "eve-session" },
        {
          type: "rollback",
          snapshotId: "snapshot-owned-older",
          confirmation: "sandbox-a",
        },
      ).pipe(Effect.provide(SandboxWorkspaceLive)),
    );

    expect(provider.getSnapshot).toHaveBeenCalledWith({
      snapshotId: "snapshot-owned-older",
    });
    expect(provider.deletedSnapshot).toHaveBeenCalledOnce();
    expect(provider.liveSandbox.update).toHaveBeenCalledWith({
      currentSnapshotId: "snapshot-owned-older",
    });
  });

  it("rejects a foreign rollback snapshot before updating the sandbox", async () => {
    await expect(
      Effect.runPromise(
        manageWorkspaceSnapshots(
          { sessionId: "eve-session" },
          {
            type: "rollback",
            snapshotId: "snapshot-foreign",
            confirmation: "sandbox-a",
          },
        ).pipe(Effect.provide(SandboxWorkspaceLive)),
      ),
    ).rejects.toMatchObject({
      kind: "not_found",
      operation: "manage the snapshot",
    });

    expect(provider.liveSandbox.update).not.toHaveBeenCalled();
  });
});
