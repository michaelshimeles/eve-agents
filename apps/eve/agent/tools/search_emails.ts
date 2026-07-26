import { defineTool } from "eve/tools";
import { z } from "zod";

import { parseAddress, searchMessages } from "../lib/agentmail";
import { agentName } from "../lib/owner";

export default defineTool({
  description: `Full-text search across ${agentName()}'s own email: sender, recipients, subject, and message bodies, ranked by relevance. Use this to find a specific email ("the invoice from Stripe", "what did the recruiter say"). Spam and trash are excluded. Returns matches with thread ids - read the whole conversation with read_email.`,
  inputSchema: z.object({
    query: z.string().min(1).describe("Keywords to search for."),
    limit: z.number().int().min(1).max(25).default(10).describe("How many matches to return."),
  }),
  async execute({ query, limit }) {
    const messages = await searchMessages(query, { limit });
    return {
      query,
      matches: messages.map((message) => ({
        threadId: message.thread_id,
        messageId: message.message_id,
        from: parseAddress(message.from).address,
        to: (message.to ?? []).map((recipient) => parseAddress(recipient).address),
        subject: message.subject ?? "(no subject)",
        preview: message.preview ?? "",
        date: message.timestamp,
      })),
    };
  },
});
