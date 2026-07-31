import { describe, expect, it } from "vitest";

import {
  decryptProviderIdentifier,
  encryptProviderIdentifier,
} from "./store";

const KEY = "11".repeat(32);

describe("opaque iMessage provider identifiers", () => {
  it("round-trips through AES-256-GCM without exposing the provider id", () => {
    const providerId = "p:0/ABCDEF-123456";
    const encrypted = encryptProviderIdentifier(providerId, KEY);
    expect(encrypted).not.toContain(providerId);
    expect(decryptProviderIdentifier(encrypted, KEY)).toBe(providerId);
  });

  it("uses a random nonce", () => {
    expect(encryptProviderIdentifier("same", KEY)).not.toBe(
      encryptProviderIdentifier("same", KEY),
    );
  });

  it("refuses tampering and a wrong key", () => {
    const encrypted = encryptProviderIdentifier("provider-guid", KEY);
    expect(() => decryptProviderIdentifier(`${encrypted}x`, KEY)).toThrow();
    expect(() => decryptProviderIdentifier(encrypted, "22".repeat(32))).toThrow();
  });
});
