import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWebAuth: vi.fn(),
  webRequestPrincipal: vi.fn(),
  listChatFiles: vi.fn(),
  registerChatFile: vi.fn(),
  runApp: vi.fn(async (program: unknown) => await program),
}));

vi.mock("@/lib/web-auth", () => ({
  requireWebAuth: mocks.requireWebAuth,
  webRequestPrincipal: mocks.webRequestPrincipal,
}));

vi.mock("@/agent/lib/effect/chat-files", () => ({
  listChatFiles: mocks.listChatFiles,
  registerChatFile: mocks.registerChatFile,
}));

vi.mock("@/agent/lib/effect/runtime", () => ({
  runApp: mocks.runApp,
}));

import { GET, POST } from "./route";

const owner = { principalId: "web:owner" };
const file = {
  id: "019c6e27-e55b-73d1-87d8-4e01f1f75043",
  threadId: "019c7714-3b77-74d1-9866-e1f484aae2ab",
  threadTitle: "Images",
  filename: "photo.png",
  mediaType: "image/png",
  sizeBytes: 42,
  createdAt: "2026-07-29T22:00:00.000Z",
};

describe("/api/files owner scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWebAuth.mockResolvedValue(null);
    mocks.webRequestPrincipal.mockReturnValue(owner);
    mocks.listChatFiles.mockResolvedValue([file]);
    mocks.registerChatFile.mockResolvedValue(file);
  });

  it("scopes file listing to the app's stable owner", async () => {
    const response = await GET(new Request("https://ruth.example/api/files"));

    expect(response.status).toBe(200);
    expect(mocks.listChatFiles).toHaveBeenCalledExactlyOnceWith(
      owner.principalId,
    );
  });

  it("never accepts a client-supplied owner when registering metadata", async () => {
    const request = new Request("https://ruth.example/api/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...file,
        ownerId: "attacker",
        blobUrl:
          "https://store.private.blob.vercel-storage.com/chat-files/photo.png",
        blobPath: `chat-files/${file.id}/photo.png`,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.registerChatFile).toHaveBeenCalledExactlyOnceWith(
      owner.principalId,
      expect.not.objectContaining({ ownerId: "attacker" }),
    );
  });
});
