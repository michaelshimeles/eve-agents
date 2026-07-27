import { defineTool } from "eve/tools";
import { z } from "zod";

import { createWebhook, webhookUrl } from "../lib/webhooks-db";
import { ownerOnly } from "../lib/owner-gate";

function telegramChatId(attributes: Record<string, unknown>): string | null {
  const chatId = attributes.chat_id;
  return chatId === undefined || chatId === null ? null : String(chatId);
}

export default defineTool({
  approval: ownerOnly,
  description:
    "Create an event trigger: a webhook URL that wakes you when an external service POSTs to it (deploy failed, form submitted, payment received, email rule matched). You receive the payload, follow the stored instruction, and message Micky. Give him the returned URL to paste into the service.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe('Short human label for what sends to this hook, e.g. "Vercel deploy alerts".'),
    prompt: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        "Instruction to your future self when an event arrives: how to interpret the payload, what to check or do, and what to tell Micky. The fired session has no chat history, so include all context.",
      ),
  }),
  async execute({ name, prompt }, ctx) {
    // Delivery follows origin: a hook created from Telegram reports into that
    // DM; one created from web chat lands as a new web chat thread.
    const attributes = ctx.session.auth.current?.attributes ?? {};
    const hook = await createWebhook({
      name,
      prompt,
      chatId: telegramChatId(attributes),
    });

    return {
      id: hook.id,
      name: hook.name,
      url: webhookUrl(hook),
      note: "Anyone with this URL can trigger the hook; treat it like a password.",
    };
  },
});
