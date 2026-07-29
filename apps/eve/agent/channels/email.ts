import { POST, defineChannel } from "eve/channels";

import { emailConfigured, type Message } from "../lib/agentmail";
import { handleInboundMessage, inboundSigningSecret } from "../lib/email-inbound";
import { verifyWebhookSignature } from "../lib/webhook-signature";

// Inbound email. AgentMail POSTs a Svix-signed event here whenever mail lands
// in the agent's inbox, and the agent wakes up in a new web chat thread to
// triage it (see lib/email-inbound.ts). Mounted at POST
// /eve/v1/email/inbound; the schedule registers this URL with AgentMail and
// stores the signing secret, so nothing but AGENTMAIL_API_KEY is required.
//
// Unsigned requests are refused outright: the payload decides what the agent
// wakes up and does, so an unauthenticated caller could put words in a
// stranger's mouth.

interface ReceivedEvent {
  event_type?: string;
  message?: Message;
}

export default defineChannel({
  routes: [
    POST("/eve/v1/email/inbound", async (req, { waitUntil }) => {
      if (!(await emailConfigured())) return new Response("Email is not configured", { status: 503 });

      const secret = await inboundSigningSecret();
      if (secret === null) {
        console.error(
          "Inbound email rejected: no Svix signing secret. Set AGENTMAIL_WEBHOOK_SECRET, or let the email schedule register the webhook.",
        );
        return new Response("Webhook signing secret is not configured", { status: 503 });
      }

      // Signature verification needs the exact bytes, so read the body as text
      // and parse it only after it checks out.
      const body = await req.text();
      const verification = verifyWebhookSignature(secret, req.headers, body);
      if (!verification.ok) {
        console.error(`Inbound email rejected: ${verification.reason}.`);
        return new Response("Invalid signature", { status: 401 });
      }

      let event: ReceivedEvent;
      try {
        event = JSON.parse(body) as ReceivedEvent;
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      // Only real inbound mail wakes the agent. message.sent would loop, and
      // spam/blocked/unauthenticated variants stay in the inbox unannounced.
      if (event.event_type !== "message.received" || event.message === undefined) {
        return Response.json({ ok: true, ignored: event.event_type ?? "unknown" });
      }

      const message = event.message;
      waitUntil(
        handleInboundMessage(message, "webhook").catch((error: unknown) => {
          console.error(`Inbound email ${message.message_id} failed.`, error);
        }),
      );

      // Ack immediately; Svix retries on any non-2xx and the work runs on.
      return Response.json({ ok: true });
    }),
  ],
});
