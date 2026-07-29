import { defineTool } from "eve/tools";
import { z } from "zod";

import { deleteWebhook } from "../lib/webhooks-db";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description:
    "Delete an event-trigger webhook by id (find it with list_webhooks). The URL stops working immediately; remind Micky to remove it from the sending service too.",
  inputSchema: z.object({
    id: z.string().min(1),
  }),
  async execute({ id }) {
    const deleted = await deleteWebhook(id);
    if (deleted === null) {
      throw new Error(`No webhook with id ${id}. Use list_webhooks to see current ids.`);
    }
    return { id: deleted.id, name: deleted.name, deleted: true };
  },
});
