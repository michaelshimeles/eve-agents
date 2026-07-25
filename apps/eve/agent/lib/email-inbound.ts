import {
  HANDLED_LABEL,
  UNREAD_LABEL,
  clipBody,
  ensureInboundWebhook,
  getEmailAddress,
  messageBody,
  parseAddress,
  updateMessageLabels,
  type Message,
} from "./agentmail";
import {
  claimInboundMessage,
  getWebhookRegistration,
  recordInboundResult,
  releaseInboundClaim,
  saveWebhookRegistration,
} from "./email-db";
import { ownerName } from "./owner";
import { deliverToWebChatThread } from "./web-thread-delivery";

// Inbound email: turning a received message into a proactive session. Two
// paths feed this, an AgentMail webhook (agent/channels/email.ts) and the
// polling schedule (agent/schedules/email.ts); both claim the message first so
// it is handled once. The agent triages in a new web chat thread rather than
// auto-replying - the reply tools still run through the usual confirmation.

/** Idempotency key for the AgentMail webhook we register for ourselves. */
export const INBOUND_WEBHOOK_CLIENT_ID = "eve-agent-inbound";

const MAX_BODY_CHARS = 4000;

/** Public URL of our inbound route. Prefers the stable production domain. */
export function inboundWebhookUrl(): string | null {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL ?? null;
  if (host === null || host.length === 0) return null;
  return `https://${host}/eve/v1/email/inbound`;
}

/**
 * Svix signing secret for the inbound route: an explicitly configured one
 * wins, otherwise whatever the schedule stored when it registered the webhook.
 */
export async function inboundSigningSecret(): Promise<string | null> {
  const configured = process.env.AGENTMAIL_WEBHOOK_SECRET?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  try {
    const registration = await getWebhookRegistration(INBOUND_WEBHOOK_CLIENT_ID);
    return registration?.secret ?? null;
  } catch (error) {
    console.error("Reading the stored AgentMail webhook secret failed.", error);
    return null;
  }
}

/**
 * Points AgentMail's `message.received` webhook at this deployment and stores
 * the signing secret. Confirms against AgentMail itself on every run rather
 * than trusting the stored row: a webhook can vanish out from under the cache
 * (console cleanup, an API key pointing at a different org), and believing a
 * stale row would leave inbound push silently dead. Idempotent throughout, so
 * calling it every schedule run is the intended use.
 */
export async function ensureInboundWebhookRegistered(): Promise<
  { registered: true; url: string } | { registered: false; reason: string }
> {
  const url = inboundWebhookUrl();
  if (url === null) {
    return { registered: false, reason: "no public deployment URL, so inbound uses polling only" };
  }

  const webhook = await ensureInboundWebhook(url, INBOUND_WEBHOOK_CLIENT_ID);
  // Keep the stored row (the channel's signing-secret source) in step with
  // whatever AgentMail actually has - recreated webhooks get new secrets.
  const stored = await getWebhookRegistration(INBOUND_WEBHOOK_CLIENT_ID);
  if (stored === null || stored.secret !== webhook.secret || stored.url !== url) {
    await saveWebhookRegistration(INBOUND_WEBHOOK_CLIENT_ID, {
      webhookId: webhook.webhook_id,
      url,
      secret: webhook.secret,
    });
  }
  return { registered: true, url };
}

function inboundPrompt(message: Message, ownAddress: string): string {
  const sender = parseAddress(message.from);
  const recipients = (message.to ?? []).map((entry) => parseAddress(entry).address);
  return [
    `New email in your own inbox (${ownAddress}). This arrived on its own - ${ownerName()} didn't just message you.`,
    "",
    `From: ${sender.name !== null ? `${sender.name} <${sender.address}>` : sender.address}`,
    `To: ${recipients.join(", ") || ownAddress}`,
    `Subject: ${message.subject ?? "(no subject)"}`,
    `Received: ${message.timestamp}`,
    `Thread id: ${message.thread_id}`,
    `Message id: ${message.message_id}`,
    "",
    "Body:",
    "```",
    clipBody(messageBody(message), MAX_BODY_CHARS) || "(empty body)",
    "```",
    "",
    `Triage it: say who wrote and what they want, then what you suggest doing. Use read_email if you need the rest of the thread. Draft a reply if one is obviously needed, but do not send anything until ${ownerName()} says yes - reply_to_email is how you answer once he does. If it is spam or needs nothing, say so in one line and add a label with label_email instead of asking.`,
  ].join("\n");
}

function threadTitle(message: Message): string {
  const sender = parseAddress(message.from);
  const subject = message.subject ?? "(no subject)";
  return `Email from ${sender.name ?? sender.address}: ${subject}`;
}

export interface InboundOutcome {
  handled: boolean;
  reason?: string;
  webThreadId?: string;
}

/**
 * Claims a received message and wakes the agent with it in a new web chat
 * thread. Returns `handled: false` when another delivery already took it.
 */
export async function handleInboundMessage(
  message: Message,
  source: "webhook" | "poll",
): Promise<InboundOutcome> {
  const claimed = await claimInboundMessage(message.message_id, message.thread_id, source);
  if (!claimed) return { handled: false, reason: "already claimed" };

  // Claimed before this check on purpose: a self-addressed message must be
  // remembered as seen, or every later poll re-examines it.
  const ownAddress = await getEmailAddress();
  const sender = parseAddress(message.from).address.toLowerCase();
  if (sender === ownAddress.toLowerCase()) {
    await recordInboundResult(message.message_id, { status: "skipped" }).catch(() => undefined);
    return { handled: false, reason: "own outbound message" };
  }

  try {
    const webThreadId = await deliverToWebChatThread(
      threadTitle(message),
      inboundPrompt(message, ownAddress),
      "email",
    );
    await recordInboundResult(message.message_id, { status: "ok", webThreadId });
    // The agent has now seen it; leaving it unread would re-surface it on the
    // next poll even though the claim already stops a second dispatch.
    await updateMessageLabels(message.message_id, {
      add: [HANDLED_LABEL],
      remove: [UNREAD_LABEL],
    }).catch((error: unknown) => {
      console.error(`Marking email ${message.message_id} handled failed.`, error);
    });
    return { handled: true, webThreadId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Handling inbound email ${message.message_id} failed.`, error);
    // Drop the claim so the next poll retries instead of losing the email.
    await releaseInboundClaim(message.message_id).catch(() => undefined);
    return { handled: false, reason };
  }
}
