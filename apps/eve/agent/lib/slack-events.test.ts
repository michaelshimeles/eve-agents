import { describe, expect, it } from "vitest";

import {
  UNRESOLVED,
  commandText,
  isDirectMessageChannel,
  reactedMessageRef,
  resolveReaction,
} from "./slack-events";

const PARENT = "1700000000.000100";
const REPLY = "1700000000.000200";

/** A `conversations.replies` response carrying `messages`. */
function replies(messages: unknown[]) {
  return { ok: true, messages } as never;
}

describe("resolveReaction", () => {
  it("anchors a top-level message on its own ts", () => {
    expect(resolveReaction(replies([{ ts: PARENT, text: "hi", user: "U1" }]), PARENT)).toEqual({
      text: "hi",
      user: "U1",
      threadTs: PARENT,
    });
  });

  it("anchors a thread parent on its own ts", () => {
    const response = replies([
      { ts: PARENT, thread_ts: PARENT, text: "root", user: "U1" },
      { ts: REPLY, thread_ts: PARENT, text: "re", user: "U2" },
    ]);
    expect(resolveReaction(response, PARENT)).toEqual({
      text: "root",
      user: "U1",
      threadTs: PARENT,
    });
  });

  // The defect this module was extracted for: a reply's own ts is not a valid
  // thread anchor, so a reaction on a reply has to resolve the parent.
  it("anchors a threaded reply on its parent, never on the reply's own ts", () => {
    const response = replies([
      { ts: PARENT, thread_ts: PARENT, text: "root", user: "U1" },
      { ts: REPLY, thread_ts: PARENT, text: "re", user: "U2" },
    ]);
    const resolved = resolveReaction(response, REPLY);
    expect(resolved).toEqual({ text: "re", user: "U2", threadTs: PARENT });
    expect(resolved.threadTs).not.toBe(REPLY);
  });

  // The reacted reply can fall outside the fetched page of a long thread. The
  // text is then unavailable, but Slack still returns the parent first, so the
  // anchor stays correct rather than falling back to the reply's ts.
  it("keeps the parent anchor when the reacted reply is past the fetched page", () => {
    const response = replies([{ ts: PARENT, thread_ts: PARENT, text: "root", user: "U1" }]);
    const resolved = resolveReaction(response, "1700000000.009999");
    expect(resolved).toEqual({ text: null, user: null, threadTs: PARENT });
    expect(resolved.threadTs).not.toBe("1700000000.009999");
  });

  it("reports no anchor for a response with no usable messages", () => {
    expect(resolveReaction(replies([]), PARENT)).toEqual(UNRESOLVED);
    expect(resolveReaction({ ok: true } as never, PARENT)).toEqual(UNRESOLVED);
    expect(resolveReaction(replies([null, 7]), PARENT)).toEqual(UNRESOLVED);
  });

  it("keeps the anchor when the message carries no text or author", () => {
    expect(resolveReaction(replies([{ ts: PARENT }]), PARENT)).toEqual({
      text: null,
      user: null,
      threadTs: PARENT,
    });
  });
});

describe("reactedMessageRef", () => {
  it("reads channel and ts off a message reaction", () => {
    const event = { type: "reaction_added", item: { type: "message", channel: "C1", ts: PARENT } };
    expect(reactedMessageRef(event as never)).toEqual({ channelId: "C1", ts: PARENT });
  });

  it("ignores reactions on anything that is not a message", () => {
    const event = { type: "reaction_added", item: { type: "file", file: "F1" } };
    expect(reactedMessageRef(event as never)).toBeNull();
  });

  it("ignores an event with a missing or incomplete item", () => {
    expect(reactedMessageRef({ type: "reaction_added" } as never)).toBeNull();
    expect(
      reactedMessageRef({
        type: "reaction_added",
        item: { type: "message", channel: "", ts: PARENT },
      } as never),
    ).toBeNull();
  });
});

describe("commandText", () => {
  it("leaves a bare command alone", () => {
    expect(commandText("/new")).toBe("/new");
  });

  // Slack delivers a mention as "<@U123> /new", so the token has to come off
  // or an addressed command never matches.
  it("strips mention tokens so an addressed command still matches", () => {
    expect(commandText("<@U123> /new")).toBe("/new");
    expect(commandText("/new <@U123>")).toBe("/new");
  });

  it("leaves ordinary prose readable", () => {
    expect(commandText("<@U123> hey what's up")).toBe("hey what's up");
  });
});

describe("isDirectMessageChannel", () => {
  it("treats D-prefixed ids as DMs and others as channels", () => {
    expect(isDirectMessageChannel("D123")).toBe(true);
    expect(isDirectMessageChannel("C123")).toBe(false);
    expect(isDirectMessageChannel("G123")).toBe(false);
  });
});
