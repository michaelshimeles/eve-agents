import { describe, expect, it } from "vitest";

import { normalizeNumber, splitMessageText } from "./agentphone";

// normalizeNumber decides who counts as the owner, so a wrong answer here is
// an admission-control bug, not a formatting one. splitMessageText decides how
// many segments get billed.

describe("normalizeNumber", () => {
  it("accepts E.164 unchanged", () => {
    expect(normalizeNumber("+15551234567")).toBe("+15551234567");
  });

  it("normalizes the shapes people actually type", () => {
    for (const input of [
      "+1 555 123 4567",
      "(555) 123-4567",
      "555-123-4567",
      "5551234567",
      "15551234567",
      "1 (555) 123-4567",
      "  +1-555-123-4567  ",
    ]) {
      expect(normalizeNumber(input)).toBe("+15551234567");
    }
  });

  it("passes group ids through untouched", () => {
    expect(normalizeNumber("grp_abc123")).toBe("grp_abc123");
    expect(normalizeNumber("grp_A-b_9")).toBe("grp_A-b_9");
  });

  it("rejects anything that is not a number or a group id", () => {
    for (const input of ["", "   ", "hello", "+", "123", "+0123456789", "grp_", "not a phone"]) {
      expect(normalizeNumber(input)).toBeNull();
    }
  });

  it("keeps distinct numbers distinct", () => {
    expect(normalizeNumber("5551234567")).not.toBe(normalizeNumber("5551234568"));
  });

  it("accepts international numbers", () => {
    expect(normalizeNumber("+442071234567")).toBe("+442071234567");
    expect(normalizeNumber("+81 3 1234 5678")).toBe("+81312345678");
  });
});

describe("splitMessageText", () => {
  it("returns a single chunk for an ordinary reply", () => {
    expect(splitMessageText("on my way")).toEqual(["on my way"]);
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(splitMessageText("")).toEqual([]);
    expect(splitMessageText("   \n  ")).toEqual([]);
  });

  it("never emits a chunk over the cap", () => {
    const chunks = splitMessageText("word ".repeat(2000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1600);
  });

  it("preserves the whole message across chunks", () => {
    const long = Array.from({ length: 400 }, (_, i) => `sentence ${i}.`).join(" ");
    const rejoined = splitMessageText(long).join(" ");
    expect(rejoined.replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " "));
  });

  it("breaks at a paragraph seam rather than mid-word", () => {
    const para = `${"a".repeat(1000)}\n\n${"b".repeat(1000)}`;
    const chunks = splitMessageText(para);
    expect(chunks[0]).toBe("a".repeat(1000));
    expect(chunks[1]).toBe("b".repeat(1000));
  });

  it("falls back to a space seam when there is no paragraph break", () => {
    const chunks = splitMessageText(`${"a".repeat(1000)} ${"b".repeat(1000)}`);
    expect(chunks[0]).toBe("a".repeat(1000));
    expect(chunks[0].endsWith("a")).toBe(true);
  });

  it("still terminates on a single unbroken run with no seam at all", () => {
    const chunks = splitMessageText("x".repeat(5000));
    expect(chunks.length).toBe(4);
    expect(chunks.join("")).toBe("x".repeat(5000));
  });
});
