import { afterEach, describe, expect, it, vi } from "vitest";

import { configuredClerkOwnerId, ownerAccessFor } from "./owner-auth-policy";

describe("owner auth policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("trims the configured owner id and treats blank as missing", () => {
    vi.stubEnv("CLERK_OWNER_USER_ID", "  user_owner  ");
    expect(configuredClerkOwnerId()).toBe("user_owner");
    vi.stubEnv("CLERK_OWNER_USER_ID", "  ");
    expect(configuredClerkOwnerId()).toBeNull();
  });

  it.each([
    [null, null, "unconfigured"],
    ["user_owner", null, "signed-out"],
    ["user_owner", "user_other", "forbidden"],
    ["user_owner", "user_owner", "allowed"],
  ] as const)("maps owner %s and user %s to %s", (ownerId, userId, expected) => {
    expect(ownerAccessFor(ownerId, userId)).toBe(expected);
  });
});
