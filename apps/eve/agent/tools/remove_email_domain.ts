import { defineTool } from "eve/tools";
import { z } from "zod";

import { removeEmailDomain } from "../lib/email-domain";
import { agentName, ownerName } from "../lib/owner";

export default defineTool({
  description: `Disconnect ${agentName()}'s custom email domain: the domain is removed from AgentMail and the address goes back to agentmail.to. Mail already received on the custom address stays stored but stops being the active inbox, and new mail sent to that address will bounce once its DNS records are removed. Confirm with ${ownerName()} before calling this.`,
  inputSchema: z.object({}),
  async execute() {
    const state = await removeEmailDomain();
    return { connected: false as const, emailAddress: state.emailAddress };
  },
});
