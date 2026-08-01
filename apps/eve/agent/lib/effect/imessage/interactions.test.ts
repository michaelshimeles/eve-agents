import { afterEach, describe, expect, it, vi } from "vitest";

import { ownerActionAuthenticated } from "./interactions";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sensitive iMessage interaction owner authentication", () => {
  it("fails closed when no sufficiently strong owner secret is configured", () => {
    vi.stubEnv("IMESSAGE_OWNER_ACTION_SECRET", "");
    expect(ownerActionAuthenticated(null)).toBe(false);
    expect(ownerActionAuthenticated("anything")).toBe(false);

    vi.stubEnv("IMESSAGE_OWNER_ACTION_SECRET", "too-short");
    expect(ownerActionAuthenticated("too-short")).toBe(false);
  });

  it("accepts only an exact constant-time bearer value", () => {
    const secret = "owner-secret-that-is-at-least-thirty-two-bytes";
    vi.stubEnv("IMESSAGE_OWNER_ACTION_SECRET", secret);
    expect(ownerActionAuthenticated(`Bearer ${secret}`)).toBe(true);
    expect(ownerActionAuthenticated(`${secret}-wrong`)).toBe(false);
  });
});
