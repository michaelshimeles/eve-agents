import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  openArtifactContent: vi.fn(),
  runApp: vi.fn(async (value: unknown) => value),
}));

vi.mock("@/agent/lib/effect/artifacts", () => ({
  openArtifactContent: dependencies.openArtifactContent,
}));

vi.mock("@/agent/lib/effect/runtime", () => ({
  runApp: dependencies.runApp,
}));

vi.mock("@/lib/web-auth", () => ({
  requireWebAuth: () => null,
}));

import { GET } from "./route";

describe("GET /api/artifacts/[id]/content", () => {
  beforeEach(() => {
    dependencies.openArtifactContent.mockReset();
    dependencies.runApp.mockClear();
  });

  it("streams private Blob content when the storage response omits its length", async () => {
    const content = "# Visible artifact\n\nThe preview should render this.";
    const bytes = new TextEncoder().encode(content);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    dependencies.openArtifactContent.mockReturnValue({
      version: {
        filename: "plan.md",
        sizeBytes: bytes.byteLength,
      },
      blob: {
        stream,
        blob: {
          contentType: "text/markdown",
          size: 0,
        },
      },
    });

    const response = await GET(
      new Request("http://localhost/api/artifacts/artifact-id/content"),
      { params: Promise.resolve({ id: "artifact-id" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(await response.text()).toBe(content);
  });
});
