import { defineSchedule } from "eve/schedules";

import { UNREAD_LABEL, emailConfigured, getMessage, listMessages } from "../lib/agentmail";
import { claimInboundMessage, claimedMessageIds, inboundLedgerIsEmpty } from "../lib/email-db";
import { ensureInboundWebhookRegistered, handleInboundMessage } from "../lib/email-inbound";

// Keeps the agent's own inbox wired up and current. Two jobs per run:
//
// 1. Point AgentMail's message.received webhook at this deployment. Idempotent,
//    and self-healing after a domain change.
// 2. Sweep for unread mail the webhook never delivered - a failed signature, a
//    deploy mid-delivery, or a deployment that has no webhook at all. Claims in
//    Neon mean a message the webhook already handled is skipped here.
//
// Every five minutes rather than every minute: the webhook is the fast path, so
// this only needs to be a safety net.

/** Cap per run so a backlog trickles in instead of flooding the chat sidebar. */
const MAX_PER_RUN = 3;

/** Ignore unread mail older than this; anything else is history, not news. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export default defineSchedule({
  cron: "*/5 * * * *",
  async run({ waitUntil }) {
    if (!(await emailConfigured())) return;

    try {
      const result = await ensureInboundWebhookRegistered();
      if (!result.registered) console.info(`Inbound email webhook not registered: ${result.reason}.`);
    } catch (error) {
      console.error("Registering the inbound email webhook failed.", error);
    }

    const unread = await listMessages({ labels: [UNREAD_LABEL], limit: 25 });

    // First run on a fresh deployment: adopt whatever is already sitting in the
    // inbox as seen, so history doesn't arrive as a pile of proactive threads.
    // Adopted mail keeps its unread label on purpose - the human never read it,
    // and the email page should say so; the claim is what stops re-dispatch.
    if (await inboundLedgerIsEmpty()) {
      for (const message of unread.messages) {
        await claimInboundMessage(message.message_id, message.thread_id, "seed");
      }
      if (unread.messages.length > 0) {
        console.info(`Adopted ${unread.messages.length} existing unread email(s) as seen.`);
      }
      return;
    }

    // Skip claimed mail (seeded, or handled and left unread) before taking the
    // per-run slots, so backlog can never crowd out a genuinely new arrival.
    const claimed = await claimedMessageIds(unread.messages.map((item) => item.message_id));
    const fresh = unread.messages
      .filter((message) => !claimed.has(message.message_id))
      .filter((message) => Date.now() - new Date(message.timestamp).getTime() < MAX_AGE_MS)
      .slice(0, MAX_PER_RUN);

    for (const item of fresh) {
      waitUntil(
        (async () => {
          try {
            // The list projection has no body, and triage needs one.
            const message = await getMessage(item.message_id);
            await handleInboundMessage(message, "poll");
          } catch (error) {
            console.error(`Polled email ${item.message_id} failed.`, error);
          }
        })(),
      );
    }
  },
});
