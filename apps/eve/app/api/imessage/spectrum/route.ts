import { randomUUID } from "node:crypto";

import { start } from "workflow/api";

import {
  imessageRouterConfigured,
  parseSpectrumDelivery,
  spectrumWebhookSecret,
} from "@/agent/lib/effect/imessage";
import {
  advancedIMessageConfigured,
  advancedIMessageSupportsPhone,
} from "@/agent/lib/effect/imessage/advanced";
import { enqueueIMessageIngress } from "@/agent/lib/effect/imessage/store";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  SPECTRUM_SIGNATURE_HEADER,
  SPECTRUM_TIMESTAMP_HEADER,
  verifyV0Signature,
} from "@/agent/lib/imessage-signature";
import { imessageIngressWorkflow } from "@/app/workflows/imessage-ingress";
import { imessageRetentionWorkflow } from "@/app/workflows/imessage-retention";
import { imessageAdvancedEventWorkflow } from "@/app/workflows/imessage-events";

/**
 * Photon’s project webhook. The request boundary does only the work required
 * for a durable acknowledgement: exact-body HMAC verification, validation,
 * a unique inbox insert, and a Workflow wake-up. Model work and forwarding
 * happen after the response in an ordered per-conversation worker.
 */
export async function POST(request: Request): Promise<Response> {
  if (!imessageRouterConfigured()) {
    return new Response("Not found", { status: 404 });
  }
  const secret = spectrumWebhookSecret();
  if (secret === null) return new Response("Not found", { status: 404 });

  const rawBody = await request.text();
  const verification = verifyV0Signature({
    secret,
    timestamp: request.headers.get(SPECTRUM_TIMESTAMP_HEADER),
    signature: request.headers.get(SPECTRUM_SIGNATURE_HEADER),
    rawBody,
  });
  if (!verification.ok) {
    return new Response("Invalid signature", { status: 401 });
  }

  const delivery = parseSpectrumDelivery(rawBody);
  if (delivery === null) return new Response("Invalid payload", { status: 400 });
  if (delivery.event !== "messages") {
    return Response.json({ ok: true, ignored: delivery.event });
  }

  const phone = delivery.space.phone?.trim() || "shared";
  const conversationKey = `conversation:${phone}:${delivery.space.id}`;
  let queued: { id: string; inserted: boolean };
  try {
    queued = await runApp(
      enqueueIMessageIngress({
        source: "webhook",
        providerEventId: delivery.message.id,
        phone,
        conversationKey,
        rawBody,
      }),
    );
    const workflows = [
      start(
        imessageIngressWorkflow,
        [conversationKey, randomUUID()],
        { deploymentId: "latest" },
      ),
      start(
        imessageRetentionWorkflow,
        [randomUUID()],
        { deploymentId: "latest" },
      ),
    ];
    if (
      advancedIMessageConfigured() &&
      advancedIMessageSupportsPhone(phone)
    ) {
      workflows.push(
        start(
          imessageAdvancedEventWorkflow,
          [phone, randomUUID()],
          { deploymentId: "latest" },
        ),
      );
    }
    await Promise.all(workflows);
  } catch {
    // A 5xx makes Photon retry. The unique inbox identity makes the insert
    // and the Workflow wake safe if the first attempt succeeded partially.
    return new Response("Durable queue unavailable", { status: 503 });
  }

  return Response.json(
    { ok: true, queued: queued.inserted, eventId: queued.id },
    { status: 202 },
  );
}
