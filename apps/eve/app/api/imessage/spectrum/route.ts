import {
  imessageRouterConfigured,
  lookupIMessageRegistration,
  markIMessageInboundRead,
  normalizeHandle,
  parseSpectrumDelivery,
  spectrumWebhookSecret,
} from "@/agent/lib/effect/imessage";
import { runtime } from "@/agent/lib/effect/runtime";
import {
  ROUTER_SIGNATURE_HEADER,
  ROUTER_TIMESTAMP_HEADER,
  SPECTRUM_SIGNATURE_HEADER,
  SPECTRUM_TIMESTAMP_HEADER,
  signV0,
  verifyV0Signature,
} from "@/agent/lib/imessage-signature";

// The Spectrum webhook target — the single URL registered with Photon for the
// shared iMessage line's project. Every inbound text for every paired phone
// lands here; the router looks the sender up in its Neon registry and
// forwards the raw delivery to that deployment's /eve/v1/imessage/inbound,
// re-signed with the deployment's own pairing secret.
//
// The forward is synchronous and its failure is this route's failure: Spectrum
// retries on any non-2xx (about six attempts with backoff), which is the only
// retry queue this pipeline has, so a dropped forward must not be answered
// with a 200.

export const maxDuration = 60;

/** Long enough for the deployment to claim the message and start the turn. */
const FORWARD_TIMEOUT_MS = 25_000;

export async function POST(request: Request): Promise<Response> {
  if (!imessageRouterConfigured()) {
    return new Response("Not found", { status: 404 });
  }
  const secret = spectrumWebhookSecret();
  if (secret === null) return new Response("Not found", { status: 404 });

  // The HMAC covers the exact bytes on the wire; read text before parsing.
  const body = await request.text();
  const verification = verifyV0Signature({
    secret,
    timestamp: request.headers.get(SPECTRUM_TIMESTAMP_HEADER),
    signature: request.headers.get(SPECTRUM_SIGNATURE_HEADER),
    rawBody: body,
  });
  if (!verification.ok) {
    console.error(`Spectrum delivery rejected: ${verification.reason}.`);
    return new Response("Invalid signature", { status: 401 });
  }

  const delivery = parseSpectrumDelivery(body);
  if (delivery === null) return new Response("Invalid payload", { status: 400 });
  if (delivery.event !== "messages") {
    return Response.json({ ok: true, ignored: delivery.event });
  }

  const sender = delivery.message.sender?.id ?? "";
  const handle = normalizeHandle(sender) ?? sender;
  if (handle.length === 0) return Response.json({ ok: true, ignored: "no-sender" });

  const exit = await runtime.runPromiseExit(lookupIMessageRegistration(handle));
  if (exit._tag === "Failure") {
    console.error("iMessage registry lookup failed.", exit.cause);
    return new Response("Registry unavailable", { status: 500 });
  }
  const registration = exit.value;
  if (registration === null) {
    // A stranger texting the shared number. Deliberately silent: replying
    // would turn the line into a spam target, and 2xx stops Spectrum retries.
    console.warn(`iMessage from unpaired sender ${handle} dropped.`);
    return Response.json({ ok: true, ignored: "unpaired-sender" });
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  let accepted = false;
  try {
    const forwarded = await fetch(`${registration.deploymentUrl}/eve/v1/imessage/inbound`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ROUTER_TIMESTAMP_HEADER]: timestamp,
        [ROUTER_SIGNATURE_HEADER]: signV0(registration.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (!forwarded.ok) {
      console.error(
        `iMessage forward to ${registration.deploymentUrl} answered HTTP ${forwarded.status}.`,
      );
      return new Response("Forward failed", { status: 502 });
    }
    const outcome = (await forwarded.json().catch(() => null)) as { ignored?: unknown } | null;
    accepted = outcome !== null && outcome.ignored === undefined;
  } catch (error) {
    console.error(`iMessage forward to ${registration.deploymentUrl} failed.`, error);
    return new Response("Forward failed", { status: 502 });
  }

  // The deployment took the message, so surface the native "seen" signal.
  // Ignored forwards skip it: a duplicate was marked read when first
  // delivered, and reactions or other non-dispatching arms never wake the
  // agent. Best-effort — the turn is already running, so a receipt failure
  // must not fail the webhook into a Spectrum retry.
  if (accepted) {
    const exitRead = await runtime.runPromiseExit(
      markIMessageInboundRead({
        handle,
        messageId: delivery.message.id,
        ...(delivery.space.phone !== undefined ? { phone: delivery.space.phone } : {}),
      }),
    );
    if (exitRead._tag === "Failure") {
      console.warn("iMessage read receipt failed.", exitRead.cause);
    }
  }

  return Response.json({ ok: true });
}
