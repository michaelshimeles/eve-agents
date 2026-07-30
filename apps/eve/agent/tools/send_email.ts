import { defineTool } from "eve/tools";
import { z } from "zod";

import { getEmailAddress, sendMessage } from "../lib/agentmail";
import { agentName, ownerName } from "../lib/owner";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description: `Send an email from ${agentName()}'s own address. This is a real email to a real person, sent as you (not as ${ownerName()}) - say exactly who you're writing to and what you'll say, and get a yes from ${ownerName()} first. Plain text unless HTML actually helps. To answer an existing conversation use reply_to_email instead, so it threads properly.`,
  inputSchema: z.object({
    to: z
      .array(z.string().email())
      .min(1)
      .max(25)
      .describe("Recipient email addresses."),
    subject: z.string().min(1).max(200).describe("Subject line."),
    text: z.string().min(1).describe("Plain-text body. Write it as yourself, and sign off as you."),
    cc: z.array(z.string().email()).max(25).optional().describe("Cc addresses."),
    bcc: z.array(z.string().email()).max(25).optional().describe("Bcc addresses."),
    html: z
      .string()
      .optional()
      .describe("Optional HTML body. Only when formatting matters; always send text too."),
  }),
  async execute({ to, subject, text, cc, bcc, html }, ctx) {
    const result = await sendMessage(
      { to, subject, text, html, cc, bcc },
      // A step interrupted mid-send re-runs on resume; keying on the tool call
      // makes AgentMail return the first result instead of mailing a duplicate.
      { idempotencyKey: `send-${ctx.callId}` },
    );
    return {
      sent: true as const,
      from: await getEmailAddress(),
      to,
      subject,
      threadId: result.thread_id,
      messageId: result.message_id,
    };
  },
});
