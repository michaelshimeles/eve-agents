import { describe, expect, it } from "vitest";

import {
  GROUP_NO_REPLY_TOKEN,
  normalizeSafeGroupReply,
  safeGroupInstructions,
} from "./group-runtime";

describe("isolated iMessage group runtime", () => {
  it("explicitly excludes private data and capabilities", () => {
    const instructions = safeGroupInstructions();
    expect(instructions).toContain("no tools");
    expect(instructions).toMatch(/no\s+private owner profile/);
    expect(instructions).toMatch(/no\s+access to files/);
    expect(instructions).toContain("same group");
  });

  it("swallows only an exact no-reply result", () => {
    expect(normalizeSafeGroupReply(GROUP_NO_REPLY_TOKEN)).toBeNull();
    expect(normalizeSafeGroupReply(` ${GROUP_NO_REPLY_TOKEN} `)).toBeNull();
    expect(normalizeSafeGroupReply("Useful answer")).toBe("Useful answer");
    expect(normalizeSafeGroupReply("")).toBeNull();
  });
});
