import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { signWebhook, verifyWebhookSignature } from "./agentphone-signature";

// The signature is the only thing standing between a public webhook URL and
// anyone who finds it, so the negative cases matter more than the happy path.

const SECRET = "whsec_test";
const BODY = JSON.stringify({ event: "agent.message", data: { from: "+15551234567" } });

function now(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("signWebhook", () => {
  it("matches the documented recipe: sha256= hex over `<timestamp>.<body>`", () => {
    const ts = "1700000000";
    const expected = createHmac("sha256", SECRET).update(`${ts}.${BODY}`).digest("hex");
    expect(signWebhook(SECRET, ts, BODY)).toBe(`sha256=${expected}`);
  });

  it("is sensitive to the separator, not just the concatenation", () => {
    // `1.23` and `12.3` must not collide, or a crafted timestamp could
    // authenticate a different body.
    expect(signWebhook(SECRET, "1", ".23")).not.toBe(signWebhook(SECRET, "12", "3"));
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed delivery", () => {
    const ts = now();
    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp: ts,
      signature: signWebhook(SECRET, ts, BODY),
      rawBody: BODY,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = now();
    const signature = signWebhook(SECRET, ts, BODY);
    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp: ts,
      signature,
      rawBody: `${BODY} `,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const ts = now();
    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp: ts,
      signature: signWebhook("whsec_other", ts, BODY),
      rawBody: BODY,
    });
    expect(result.ok).toBe(false);
  });

  it("treats missing headers as a refusal rather than throwing", () => {
    const ts = now();
    expect(
      verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature: null, rawBody: BODY }).ok,
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: null,
        signature: signWebhook(SECRET, ts, BODY),
        rawBody: BODY,
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp: "not-a-number",
      signature: signWebhook(SECRET, "not-a-number", BODY),
      rawBody: BODY,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a replay outside the five-minute window, in both directions", () => {
    for (const offset of [-400, 400]) {
      const ts = String(Math.floor(Date.now() / 1000) + offset);
      const result = verifyWebhookSignature({
        secret: SECRET,
        timestamp: ts,
        signature: signWebhook(SECRET, ts, BODY),
        rawBody: BODY,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("accepts a delivery just inside the window", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 120);
    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp: ts,
      signature: signWebhook(SECRET, ts, BODY),
      rawBody: BODY,
    });
    expect(result.ok).toBe(true);
  });

  it("does not throw on a length-mismatched signature", () => {
    // timingSafeEqual throws when the buffers differ in length, so the guard
    // has to come first.
    expect(() =>
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: now(),
        signature: "sha256=short",
        rawBody: BODY,
      }),
    ).not.toThrow();
  });

  it("never leaks the reason to the caller as success", () => {
    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp: now(),
      signature: "sha256=deadbeef",
      rawBody: BODY,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.reason).toBe("string");
  });
});
