import { defineTool } from "eve/tools";
import { z } from "zod";

import { agentName, ownerName } from "../lib/owner";
import {
  DEFAULT_TIMEZONE,
  createReminder,
  nextCronOccurrence,
} from "../lib/reminders-db";
import { ownerOnly } from "../lib/owner-gate";

function telegramChatId(attributes: Record<string, unknown>): string | null {
  const chatId = attributes.chat_id;
  return chatId === undefined || chatId === null ? null : String(chatId);
}

export default defineTool({
  approval: ownerOnly,
  description: `Schedule a proactive reminder or task. ${agentName()} wakes up at the given time (one-off) or on the cron cadence (recurring), performs the prompt, and messages ${ownerName()} on Telegram. Use for 'remind me to X at 9pm', 'every weekday morning send me my schedule', or any future/recurring task.`,
  inputSchema: z.object({
    prompt: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        `Instruction to your future self when this fires: what to do or check, and what to send ${ownerName()}. Include any context needed - the fired session has no chat history.`,
      ),
    fireAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("One-off: when to fire, ISO 8601 with offset (e.g. 2026-07-23T21:00:00-04:00)."),
    cron: z
      .string()
      .optional()
      .describe(
        'Recurring: 5-field cron expression evaluated in the timezone (e.g. "0 21 * * *" for 9pm daily).',
      ),
    timezone: z
      .string()
      .default(DEFAULT_TIMEZONE)
      .describe("IANA timezone for the cron expression."),
  }),
  async execute({ prompt, fireAt, cron, timezone }, ctx) {
    if ((fireAt === undefined) === (cron === undefined)) {
      throw new Error("Provide exactly one of fireAt (one-off) or cron (recurring).");
    }

    let nextFireAt: Date;
    if (fireAt !== undefined) {
      nextFireAt = new Date(fireAt);
      if (nextFireAt.getTime() <= Date.now()) {
        throw new Error(`fireAt is in the past (${fireAt}). Pick a future time.`);
      }
    } else {
      try {
        nextFireAt = nextCronOccurrence(cron!, timezone);
      } catch (error) {
        throw new Error(
          `Invalid cron expression "${cron}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Delivery follows origin: a reminder created from Telegram replies into
    // that DM; one created from web chat (no chat id) lands as a new web
    // chat thread.
    const attributes = ctx.session.auth.current?.attributes ?? {};
    const reminder = await createReminder({
      prompt,
      cron: cron ?? null,
      timezone,
      nextFireAt,
      chatId: telegramChatId(attributes),
    });

    return {
      id: reminder.id,
      nextFireAt: reminder.next_fire_at,
      recurring: reminder.cron !== null,
    };
  },
});
