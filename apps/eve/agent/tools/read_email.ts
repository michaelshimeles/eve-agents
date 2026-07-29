import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  HANDLED_LABEL,
  UNREAD_LABEL,
  clipBody,
  getEmailAddress,
  getThread,
  messageBody,
  parseAddress,
  updateThreadLabels,
} from "../lib/agentmail";
import { agentName } from "../lib/owner";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description: `Read a full email conversation from ${agentName()}'s inbox: every message in the thread with its sender, recipients, date, and body. Get thread ids from list_emails or search_emails. Reading marks the thread read by default, which is what keeps your inbox from re-surfacing mail you already looked at. Reply with reply_to_email using the messageId of the message you're answering.`,
  inputSchema: z.object({
    threadId: z.string().min(1).describe("Thread id from list_emails or search_emails."),
    markRead: z
      .boolean()
      .default(true)
      .describe("Clear the unread flag on this thread. Set false to peek without changing state."),
  }),
  async execute({ threadId, markRead }) {
    const [thread, ownAddress] = await Promise.all([getThread(threadId), getEmailAddress()]);

    const messages = thread.messages.map((message) => {
      const sender = parseAddress(message.from);
      return {
        messageId: message.message_id,
        direction: sender.address.toLowerCase() === ownAddress.toLowerCase() ? "sent" : "received",
        from: message.from,
        to: message.to ?? [],
        cc: message.cc ?? [],
        date: message.timestamp,
        subject: message.subject ?? null,
        body: clipBody(messageBody(message)),
        attachments: (message.attachments ?? []).map((attachment) => ({
          attachmentId: attachment.attachment_id,
          filename: attachment.filename ?? "attachment",
          contentType: attachment.content_type ?? null,
          size: attachment.size,
        })),
      };
    });

    if (markRead && thread.labels.includes(UNREAD_LABEL)) {
      // Best-effort: a failed label write must not lose the message we just read.
      await updateThreadLabels(threadId, {
        add: [HANDLED_LABEL],
        remove: [UNREAD_LABEL],
      }).catch((error: unknown) => {
        console.error(`Marking email thread ${threadId} read failed.`, error);
      });
    }

    return {
      threadId: thread.thread_id,
      subject: thread.subject ?? "(no subject)",
      labels: thread.labels,
      messageCount: thread.message_count,
      lastMessageId: thread.last_message_id,
      messages,
    };
  },
});
