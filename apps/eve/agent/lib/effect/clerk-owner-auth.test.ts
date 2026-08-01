import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const { authenticateRequestMock } = vi.hoisted(() => ({
  authenticateRequestMock: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ authenticateRequest: authenticateRequestMock }),
}));

import { authenticateClerkOwnerRequest } from "./clerk-owner-auth";

describe("Clerk owner Eve auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    authenticateRequestMock.mockReset();
  });

  function configureOwner() {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_example");
    vi.stubEnv("CLERK_OWNER_USER_ID", "user_owner");
  }

  it("fails closed without a complete Clerk owner configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_example");
    vi.stubEnv("CLERK_OWNER_USER_ID", "");

    await expect(
      Effect.runPromise(
        authenticateClerkOwnerRequest(
          new Request("https://ruth.example/eve/v1/session", { method: "POST" }),
        ),
      ),
    ).resolves.toEqual({ kind: "unconfigured" });
  });

  it("accepts the configured user and binds the request origin", async () => {
    configureOwner();
    authenticateRequestMock.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => ({ userId: "user_owner" }),
    });

    await expect(
      Effect.runPromise(
        authenticateClerkOwnerRequest(
          new Request("https://ruth.example/eve/v1/session", { method: "POST" }),
        ),
      ),
    ).resolves.toEqual({ kind: "allowed", userId: "user_owner" });
    expect(authenticateRequestMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        acceptsToken: "session_token",
        authorizedParties: ["https://ruth.example"],
      }),
    );
  });

  it("rejects a valid session belonging to another Clerk user", async () => {
    configureOwner();
    authenticateRequestMock.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => ({ userId: "user_other" }),
    });

    await expect(
      Effect.runPromise(
        authenticateClerkOwnerRequest(
          new Request("https://ruth.example/eve/v1/session", { method: "POST" }),
        ),
      ),
    ).resolves.toEqual({ kind: "forbidden" });
  });
});
