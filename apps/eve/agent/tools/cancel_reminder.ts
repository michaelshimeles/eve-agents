import { defineTool } from "eve/tools";
import { z } from "zod";

import { cancelReminder } from "../lib/reminders-db";

export default defineTool({
  description:
    "Cancel an active reminder or recurring scheduled task by id (find it with list_reminders). Cancelling a recurring task stops all future runs.",
  inputSchema: z.object({
    id: z.number().int().positive(),
  }),
  async execute({ id }) {
    const cancelled = await cancelReminder(id);
    if (cancelled === null) {
      throw new Error(`No active reminder with id ${id}. Use list_reminders to see current ids.`);
    }
    return { id: cancelled.id, prompt: cancelled.prompt, cancelled: true };
  },
});
