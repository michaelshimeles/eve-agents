import { defineTool } from "eve/tools";
import { z } from "zod";

import { UNREAD_LABEL, getInbox, listThreads } from "../lib/agentmail";
import { agentName } from "../lib/owner";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description: `Get ${agentName()}'s own email address, plus how many unread threads are waiting. This is a real inbox that anyone can write to, separate from the user's personal email. Use it whenever you need to hand out your address (signing up for something, asking to be CC'd, telling the user where to forward mail) or to check whether new mail arrived.`,
  inputSchema: z.object({}),
  async execute() {
    const inbox = await getInbox();
    const unread = await listThreads({ labels: [UNREAD_LABEL], limit: 100 });
    return {
      emailAddress: inbox.email ?? inbox.inbox_id,
      displayName: inbox.display_name ?? null,
      unreadThreads: unread.count,
      createdAt: inbox.created_at,
    };
  },
});
