import { describe, expect, it } from "vitest";

import { parseVoice, speakable, voiceAuth } from "./agentphone-voice-stream";

// These three are what stand between a provider payload and a spoken turn:
// what counts as a voice event, who the caller is allowed to be, and what
// actually gets read aloud.

describe("parseVoice", () => {
  const envelope = (data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    event: "agent.message",
    channel: "voice",
    ...overrides,
    data,
  });

  it("reads a live transcript turn", () => {
    const voice = parseVoice(
      envelope({
        callId: "call_1",
        from: "+15551234567",
        to: "+15550001111",
        direction: "inbound",
        transcript: "what are your hours",
      }),
    );
    expect(voice).not.toBeNull();
    expect(voice?.callId).toBe("call_1");
    expect(voice?.transcript).toBe("what are your hours");
    expect(voice?.direction).toBe("inbound");
  });

  it("reads a call_ended envelope, which the caller handles separately", () => {
    const voice = parseVoice(
      envelope({ callId: "call_1" }, { event: "agent.call_ended" }),
    );
    expect(voice?.event).toBe("agent.call_ended");
  });

  it("ignores text deliveries, which belong to the other channel", () => {
    for (const channel of ["sms", "mms", "imessage"]) {
      expect(parseVoice(envelope({ callId: "c" }, { channel }))).toBeNull();
    }
  });

  it("ignores an envelope with no call id, which cannot address a session", () => {
    expect(parseVoice(envelope({ from: "+15551234567", transcript: "hi" }))).toBeNull();
    expect(parseVoice(envelope({ callId: "", transcript: "hi" }))).toBeNull();
  });

  it("survives malformed input instead of throwing", () => {
    for (const raw of [null, undefined, 42, "voice", [], {}, { event: 1, channel: "voice" }]) {
      expect(parseVoice(raw)).toBeNull();
    }
  });

  it("defaults a missing direction to inbound, the safer reading", () => {
    // Inbound means "guest" downstream, so an absent field must not be
    // mistaken for an outbound call Ruth placed.
    expect(parseVoice(envelope({ callId: "c", transcript: "hi" }))?.direction).toBe("inbound");
  });
});

describe("voiceAuth", () => {
  const base = {
    event: "agent.message",
    callId: "call_1",
    from: "+15551234567",
    to: "+15550001111",
    transcript: "hi",
  };

  it("labels an inbound caller a guest even when the number matches the owner", () => {
    // Caller ID is trivially spoofed, so a matching number on an INBOUND call
    // must not unlock owner-only tools.
    const auth = voiceAuth({ ...base, direction: "inbound" }, "+15551234567");
    expect(auth.attributes.role).toBe("guest");
  });

  it("labels an outbound call to the owner's own number as the owner", () => {
    const auth = voiceAuth({ ...base, direction: "outbound" }, "+15551234567");
    expect(auth.attributes.role).toBe("owner");
  });

  it("labels an outbound call to anyone else a guest", () => {
    const auth = voiceAuth({ ...base, direction: "outbound" }, "+15559998888");
    expect(auth.attributes.role).toBe("guest");
  });

  it("labels everyone a guest when no owner number is configured", () => {
    expect(voiceAuth({ ...base, direction: "outbound" }, null).attributes.role).toBe("guest");
  });

  it("carries the call id so tools can scope to this conversation", () => {
    const auth = voiceAuth({ ...base, direction: "inbound" }, null);
    expect(auth.attributes.call_id).toBe("call_1");
    expect(auth.principalId).toBe("tel:+15551234567");
  });
});

describe("speakable", () => {
  it("strips emphasis rather than reading the asterisks aloud", () => {
    expect(speakable("that is **really** important")).toBe("that is really important");
    expect(speakable("_quietly_ now")).toBe("quietly now");
  });

  it("keeps link text and drops the URL", () => {
    expect(speakable("see [the menu](https://example.com/menu)")).toBe("see the menu");
  });

  it("drops heading and bullet markers", () => {
    expect(speakable("## Hours\n- open at nine\n- closed Sunday")).toBe(
      "Hours open at nine closed Sunday",
    );
  });

  it("removes code fences, which are unreadable over a phone", () => {
    expect(speakable("run ```npm install``` first")).toBe("run first");
    expect(speakable("the `id` field")).toBe("the id field");
  });

  it("collapses whitespace so TTS does not hear ragged pauses", () => {
    expect(speakable("one\n\n  two   three\n")).toBe("one two three");
  });

  it("leaves ordinary speech untouched", () => {
    const plain = "We open at nine and close at five, except on Sundays.";
    expect(speakable(plain)).toBe(plain);
  });

  it("returns an empty string for content that was only markup", () => {
    // The caller uses length 0 to mean "nothing worth speaking".
    expect(speakable("```\ncode\n```")).toBe("");
    expect(speakable("   ")).toBe("");
  });
});
