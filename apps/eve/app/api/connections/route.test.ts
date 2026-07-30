import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const composio = vi.hoisted(() => ({
  listComposioToolkits: vi.fn(),
  manageConnections: vi.fn(),
}));

vi.mock("@/lib/composio-connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/composio-connect")>();
  return {
    ...actual,
    listComposioToolkits: composio.listComposioToolkits,
    manageConnections: composio.manageConnections,
  };
});

vi.mock("@/lib/web-auth", () => ({
  requireWebAuth: () => null,
}));

import { GET } from "./route";

describe("GET /api/connections", () => {
  beforeEach(() => {
    composio.listComposioToolkits.mockReset();
    composio.manageConnections.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still queries non-common connected apps when the live catalog is unavailable", async () => {
    composio.listComposioToolkits.mockRejectedValue(new Error("catalog unavailable"));
    composio.manageConnections.mockResolvedValue({
      results: {
        figma: {
          toolkit: "figma",
          accounts: [{ id: "account-1", status: "ACTIVE" }],
        },
      },
    });

    const response = await GET(new Request("http://localhost/api/connections"));
    const body = (await response.json()) as {
      catalogComplete: boolean;
      connections: { toolkit: string }[];
    };
    const operations = composio.manageConnections.mock.calls[0]?.[0] as
      | { name: string; action: string }[]
      | undefined;

    expect(response.status).toBe(200);
    expect(body.catalogComplete).toBe(false);
    expect(body.connections).toContainEqual(expect.objectContaining({ toolkit: "figma" }));
    expect(operations).toContainEqual({ name: "figma", action: "list" });
  });

  it("keeps live additions in the picker while querying the snapshot union", async () => {
    composio.listComposioToolkits.mockResolvedValue([
      { slug: "new_toolkit", name: "New Toolkit" },
    ]);
    composio.manageConnections.mockResolvedValue({ results: {} });

    const response = await GET(new Request("http://localhost/api/connections"));
    const body = (await response.json()) as {
      catalogComplete: boolean;
      toolkits: { slug: string; name: string }[];
    };
    const operations = composio.manageConnections.mock.calls[0]?.[0] as
      | { name: string; action: string }[]
      | undefined;

    expect(response.status).toBe(200);
    expect(body.catalogComplete).toBe(true);
    expect(body.toolkits).toEqual([{ slug: "new_toolkit", name: "New Toolkit" }]);
    expect(operations).toContainEqual({ name: "new_toolkit", action: "list" });
    expect(operations).toContainEqual({ name: "figma", action: "list" });
  });
});
