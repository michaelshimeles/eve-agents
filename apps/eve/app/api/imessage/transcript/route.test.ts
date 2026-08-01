import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireWebAuthMock } = vi.hoisted(() => ({
  requireWebAuthMock: vi.fn(),
}));

vi.mock("@/lib/web-auth", () => ({
  requireWebAuth: requireWebAuthMock,
}));

import { GET } from "./route";

const URL = "https://ruth.example.com/api/imessage/transcript";

describe("GET /api/imessage/transcript", () => {
  beforeEach(() => {
    requireWebAuthMock.mockResolvedValue(
      Response.json({ error: "Sign in to continue." }, { status: 401 }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires the Clerk owner before reading the transcript", async () => {
    const response = await GET(new Request(URL));
    expect(response.status).toBe(401);
    expect(requireWebAuthMock).toHaveBeenCalledOnce();
  });

  it("does not let the removed admin-token header bypass Clerk", async () => {
    const response = await GET(
      new Request(URL, {
        headers: { "x-imessage-admin-token": "obsolete-secret" },
      }),
    );
    expect(response.status).toBe(401);
  });
});
