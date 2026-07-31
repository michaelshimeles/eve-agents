import { describe, expect, it } from "vitest";

import { normalizeEmojiName, validateSlackReactionRules } from "./slack-reactions";

const OK = { emoji: "eyes", prompt: "Look at this.", audience: "owner" };

describe("normalizeEmojiName", () => {
  it("strips the colons a person copies out of Slack", () => {
    expect(normalizeEmojiName(":eyes:")).toBe("eyes");
  });

  it("folds case and trims", () => {
    expect(normalizeEmojiName("  EYES  ")).toBe("eyes");
  });

  // Slack sends skin-tone variants suffixed, so one rule has to cover them all.
  it("drops the skin-tone suffix", () => {
    expect(normalizeEmojiName("+1::skin-tone-3")).toBe("+1");
    expect(normalizeEmojiName(":+1::skin-tone-5:")).toBe("+1");
  });

  it("leaves ordinary and custom emoji names alone", () => {
    expect(normalizeEmojiName("white_check_mark")).toBe("white_check_mark");
    expect(normalizeEmojiName("party-parrot")).toBe("party-parrot");
  });
});

describe("validateSlackReactionRules", () => {
  it("normalizes and trims a valid list", () => {
    expect(
      validateSlackReactionRules([
        { emoji: ":Eyes:", prompt: "  Look at this.  ", audience: "owner" },
        { emoji: "+1::skin-tone-2", prompt: "Ack it.", audience: "anyone" },
      ]),
    ).toEqual([
      { emoji: "eyes", prompt: "Look at this.", audience: "owner" },
      { emoji: "+1", prompt: "Ack it.", audience: "anyone" },
    ]);
  });

  it("accepts an empty list", () => {
    expect(validateSlackReactionRules([])).toEqual([]);
  });

  // Rejected rather than last-wins: silently dropping one of two rules for the
  // same emoji makes "why did my rule stop working" hard to answer. The check
  // runs after normalization, so :EYES: and eyes collide.
  it("rejects duplicate emoji, comparing normalized names", () => {
    expect(() =>
      validateSlackReactionRules([OK, { ...OK, emoji: ":EYES:", prompt: "Other." }]),
    ).toThrow(/more than one rule for :eyes:/);
  });

  it("requires an emoji and an instruction", () => {
    expect(() => validateSlackReactionRules([{ ...OK, emoji: "" }])).toThrow(/needs an emoji/);
    expect(() => validateSlackReactionRules([{ ...OK, prompt: "   " }])).toThrow(
      /needs an instruction/,
    );
  });

  // Audience must never default: an unreadable value silently widening a rule
  // to the whole workspace is the one failure worth being strict about.
  it("fails closed on a missing or unknown audience", () => {
    expect(() => validateSlackReactionRules([{ emoji: "eyes", prompt: "x" }])).toThrow(
      /owner or for anyone/,
    );
    expect(() => validateSlackReactionRules([{ ...OK, audience: "everyone" }])).toThrow(
      /owner or for anyone/,
    );
  });

  it("bounds prompt length and rule count", () => {
    expect(() => validateSlackReactionRules([{ ...OK, prompt: "x".repeat(2001) }])).toThrow(
      /longer than 2000/,
    );
    const many = Array.from({ length: 26 }, (_, index) => ({ ...OK, emoji: `e${index}` }));
    expect(() => validateSlackReactionRules(many)).toThrow(/more than 25/);
  });

  it("rejects anything that is not a list of objects", () => {
    expect(() => validateSlackReactionRules({ rules: [] })).toThrow(/must be a list/);
    expect(() => validateSlackReactionRules([42])).toThrow(/must be an object/);
  });
});
