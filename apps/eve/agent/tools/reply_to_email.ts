import { defineTool } from "eve/tools";
import { z } from "zod";

import { HANDLED_LABEL, UNREAD_LABEL, replyToMessage, updateThreadLabels } from "../lib/agentmail";
import { agentName, ownerName } from "../lib/owner";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description: `Reply to an email in ${agentName()}'s inbox. Keeps the conversation in the same thread and quotes it for the recipient, so use this rather than send_email for any answer. Pass the messageId of the message you're answering (usually lastMessageId from read_email). Real mail going to a real person: state what you'll send and get a yes from ${ownerName()} first.`,
  inputSchema: z.object({
    messageId: z
      .string()
      .min(1)
      .describe("Message id to reply to, from read_email (lastMessageId answers the newest)."),
    text: z.string().min(1).describe("Plain-text reply body. Just your new text; the thread is quoted automatically."),
    replyAll: z
      .boolean()
      .default(false)
      .describe("Reply to everyone on the original, not just its sender."),
    cc: z.array(z.string().email()).max(25).optional().describe("Extra Cc addresses."),
    html: z.string().optional().describe("Optional HTML body. Always send text too."),
  }),
  async execute({ messageId, text, replyAll, cc, html }, ctx) {
    const result = await replyToMessage(
      messageId,
      { text, html, cc, replyAll },
      { idempotencyKey: `reply-${ctx.callId}` },
    );

    // Answering a thread settles it; leaving it unread would re-surface it.
    await updateThreadLabels(result.thread_id, {
      add: [HANDLED_LABEL],
      remove: [UNREAD_LABEL],
    }).catch((error: unknown) => {
      console.error(`Marking replied thread ${result.thread_id} read failed.`, error);
    });

    return {
      sent: true as const,
      threadId: result.thread_id,
      messageId: result.message_id,
      repliedTo: messageId,
      replyAll,
    };
  },
});
