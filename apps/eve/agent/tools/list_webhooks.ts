import { defineTool } from "eve/tools";
import { z } from "zod";

import { listWebhooks, webhookUrl } from "../lib/webhooks-db";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description:
    "List event-trigger webhooks: id, name, stored instruction, URL, and fire stats. Use when Micky asks what triggers exist, needs a hook's URL again, or wants an id to delete.",
  inputSchema: z.object({}),
  async execute() {
    const hooks = await listWebhooks();
    return {
      webhooks: hooks.map((hook) => ({
        id: hook.id,
        name: hook.name,
        prompt: hook.prompt,
        url: webhookUrl(hook),
        createdAt: hook.created_at,
        lastFiredAt: hook.last_fired_at,
        fireCount: hook.fire_count,
      })),
    };
  },
});
