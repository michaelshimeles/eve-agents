import { describe, expect, it } from "vitest";

import { maskEmail } from "./mask-email";

// Shown in the panel so the owner knows where the code went without the page
// ever holding the full address as user-editable state.

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("michael@example.com")).toBe("m•••@example.com");
  });

  it("handles one-character locals", () => {
    expect(maskEmail("a@b.co")).toBe("a•••@b.co");
  });

  it("returns null for junk", () => {
    expect(maskEmail("not-an-email")).toBeNull();
    expect(maskEmail("")).toBeNull();
    expect(maskEmail("@nope.com")).toBeNull();
    expect(maskEmail("trailing@")).toBeNull();
  });
});
