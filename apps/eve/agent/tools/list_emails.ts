import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  UNREAD_LABEL,
  listThreads,
  parseAddress,
  sentThreadItems,
  type ThreadItem,
} from "../lib/agentmail";
import { agentName } from "../lib/owner";
import { ownerOnly } from "../lib/owner-gate";

// Threads are the unit here, not messages: one row per conversation, newest
// first, the way an email client lists a mailbox. AgentMail has no direction
// filter, so inbox/sent are separated by which timestamps a thread carries.

function summarize(thread: ThreadItem) {
  return {
    threadId: thread.thread_id,
    subject: thread.subject ?? "(no subject)",
    from: thread.senders.map((sender) => parseAddress(sender).address),
    to: thread.recipients.map((recipient) => parseAddress(recipient).address),
    preview: thread.preview ?? "",
    messageCount: thread.message_count,
    lastActivityAt: thread.timestamp,
    unread: thread.labels.includes(UNREAD_LABEL),
    labels: thread.labels,
    hasAttachments: (thread.attachments ?? []).length > 0,
  };
}

export default defineTool({
  approval: ownerOnly,
  description: `List conversations in ${agentName()}'s own email inbox, newest first. Use "unread" to see what needs attention, "inbox" for mail people sent you, "sent" for what you sent, "all" for both. Returns thread summaries with previews - call read_email with a threadId for the full messages.`,
  inputSchema: z.object({
    folder: z
      .enum(["unread", "inbox", "sent", "all", "trash"])
      .default("inbox")
      .describe("Which mailbox to list."),
    limit: z.number().int().min(1).max(50).default(15).describe("How many threads to return."),
  }),
  async execute({ folder, limit }) {
    // Two live-API quirks shape this: the thread index omits conversations
    // only the agent has written to (Sent comes from sent-labelled messages
    // instead), and the label filter will not match the special "trash"
    // label (Trash lists with includeTrash and narrows here).
    if (folder === "sent") {
      const sent = await sentThreadItems(limit);
      return { folder, threads: sent.slice(0, limit).map(summarize), more: sent.length > limit };
    }

    const page = await listThreads({
      limit: folder === "all" ? limit : Math.min(50, limit * 2),
      labels: folder === "unread" ? [UNREAD_LABEL] : undefined,
      includeTrash: folder === "trash",
    });
    let matching = page.threads.filter((thread) => {
      if (folder === "trash") return thread.labels.includes("trash");
      if (folder === "inbox") return thread.received_timestamp !== undefined;
      return true;
    });
    if (folder === "all") {
      const known = new Set(matching.map((thread) => thread.thread_id));
      const extras = (await sentThreadItems(limit)).filter(
        (thread) => !known.has(thread.thread_id),
      );
      matching = [...matching, ...extras].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }

    return {
      folder,
      threads: matching.slice(0, limit).map(summarize),
      more: matching.length > limit || page.nextPageToken !== null,
    };
  },
});
