import { createHmac, timingSafeEqual } from "node:crypto";

// HMAC verification for AgentPhone webhook deliveries.
//
// AgentPhone signs every delivery with the secret it minted when the webhook
// was registered (POST /v1/webhooks returns a fresh `whsec_...` on every
// create *and* update, so the caller must persist whatever it gets back).
// The canonical string is `<timestamp>.<rawBody>` — a literal dot between the
// unix timestamp header and the exact request bytes — hashed with SHA-256 and
// sent hex-encoded behind a `sha256=` prefix.
//
// This is deliberately a separate scheme from the Spectrum/router v0 signature
// in imessage-signature.ts (`v0:<ts>:<body>` → `v0=<hex>`). The two providers
// disagree on both the separator and the prefix, so sharing a verifier would
// mean a format switch on every call; two small modules read better and make a
// signing bug impossible to hide behind the wrong branch.

/** Deliveries outside this window are refused as replays. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export const AGENTPHONE_SIGNATURE_HEADER = "x-webhook-signature";
export const AGENTPHONE_TIMESTAMP_HEADER = "x-webhook-timestamp";
/** Unique per delivery; the dedupe key, since retries reuse it. */
export const AGENTPHONE_DELIVERY_HEADER = "x-webhook-id";
export const AGENTPHONE_EVENT_HEADER = "x-webhook-event";

export type SignatureVerification = { ok: true } | { ok: false; reason: string };

/** The signature AgentPhone would send for these bytes, in wire form. */
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/**
 * Verifies one AgentPhone-signed delivery. Header values are passed as
 * received; `null` for a missing header reads as a refusal rather than an
 * exception, so a malformed request and a forged one take the same path.
 *
 * The reason string is for logs only — call sites answer a bare 401, because
 * telling a caller *why* their signature failed helps them forge a better one.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
}): SignatureVerification {
  if (input.timestamp === null || input.signature === null) {
    return { ok: false, reason: "missing timestamp or signature header" };
  }

  const sentAt = Number(input.timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "timestamp is not a number" };
  const skew = Math.abs(Date.now() / 1000 - sentAt);
  if (skew > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: `timestamp is ${Math.round(skew)}s outside the replay window` };
  }

  const expected = Buffer.from(signWebhook(input.secret, input.timestamp, input.rawBody));
  const provided = Buffer.from(input.signature);
  // timingSafeEqual throws on a length mismatch, so the guard has to come
  // first; an attacker learning only the signature's length gains nothing.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}
