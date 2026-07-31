import { defineTool } from "eve/tools";
import { z } from "zod";

import { listReminders } from "../lib/reminders-db";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description:
    "List active reminders and recurring scheduled tasks: id, prompt, next fire time, and cadence. Use when Micky asks what's scheduled, or to find an id to cancel.",
  inputSchema: z.object({}),
  async execute() {
    const reminders = await listReminders();
    return {
      reminders: reminders.map((reminder) => ({
        id: reminder.id,
        prompt: reminder.prompt,
        nextFireAt: reminder.next_fire_at,
        cron: reminder.cron,
        timezone: reminder.timezone,
        lastFiredAt: reminder.last_fired_at,
      })),
    };
  },
});
