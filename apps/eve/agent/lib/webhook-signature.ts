import { createHmac, timingSafeEqual } from "node:crypto";

// AgentMail delivers webhooks through Svix, which signs every request. The
// scheme is small and stable, so we verify it here instead of pulling in the
// Svix SDK: HMAC-SHA256 over "<id>.<timestamp>.<body>" keyed by the endpoint's
// whsec_ secret, compared against the v1 signatures in svix-signature.
// https://docs.agentmail.to/webhook-verification

/** Svix's default replay window. */
const TOLERANCE_SECONDS = 5 * 60;

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: string };

function signingKey(secret: string): Buffer {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(raw, "base64");
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verifies a Svix-signed webhook request against `secret`. `body` must be the
 * exact bytes as received — re-serialized JSON will not match.
 */
export function verifyWebhookSignature(
  secret: string,
  headers: Headers,
  body: string,
): VerificationResult {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (id === null || timestamp === null || signatures === null) {
    return { ok: false, reason: "missing svix-id, svix-timestamp, or svix-signature" };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "svix-timestamp is not a number" };
  const skew = Math.abs(Date.now() / 1000 - sentAt);
  if (skew > TOLERANCE_SECONDS) {
    return { ok: false, reason: `svix-timestamp is ${Math.round(skew)}s outside the replay window` };
  }

  const expected = createHmac("sha256", signingKey(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  // The header carries a space-delimited list so secrets can be rotated.
  for (const entry of signatures.split(" ")) {
    const [version, signature] = entry.split(",", 2);
    if (version !== "v1" || signature === undefined) continue;
    if (equals(signature, expected)) return { ok: true };
  }
  return { ok: false, reason: "no v1 signature matched" };
}
