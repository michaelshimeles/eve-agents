import { createHmac, timingSafeEqual } from "node:crypto";

// Spectrum (Photon) signs webhook deliveries with HMAC-SHA256 over
// "v0:<timestamp>:<rawBody>", carried as "v0=<64 hex chars>" — the same
// scheme Slack uses. https://photon.codes/docs/webhooks/verifying-signatures
//
// The iMessage router re-signs forwarded deliveries to deployments with the
// identical recipe, keyed by that deployment's pairing secret, so one
// verifier covers both hops. The body must be the exact bytes as received:
// re-serialized JSON will not match.

/** Spectrum's recommended replay window. */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** Headers on deliveries from Spectrum itself. */
export const SPECTRUM_EVENT_HEADER = "x-spectrum-event";
export const SPECTRUM_TIMESTAMP_HEADER = "x-spectrum-timestamp";
export const SPECTRUM_SIGNATURE_HEADER = "x-spectrum-signature";
export const SPECTRUM_WEBHOOK_ID_HEADER = "x-spectrum-webhook-id";

/** Headers on deliveries the router forwards to a paired deployment. */
export const ROUTER_TIMESTAMP_HEADER = "x-imessage-router-timestamp";
export const ROUTER_SIGNATURE_HEADER = "x-imessage-router-signature";

export function signV0(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

export type V0Verification = { ok: true } | { ok: false; reason: string };

/**
 * Verifies one v0-signed request. Pass the header values as received;
 * `null` for a missing header reads as a refusal, not an exception.
 */
export function verifyV0Signature(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
}): V0Verification {
  if (input.timestamp === null || input.signature === null) {
    return { ok: false, reason: "missing timestamp or signature header" };
  }

  const sentAt = Number(input.timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "timestamp is not a number" };
  const skew = Math.abs(Date.now() / 1000 - sentAt);
  if (skew > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: `timestamp is ${Math.round(skew)}s outside the replay window` };
  }

  const expected = signV0(input.secret, input.timestamp, input.rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}
