import { defineTool } from "eve/tools";
import { z } from "zod";

import { checkEmailDomain } from "../lib/email-domain";
import { agentName } from "../lib/owner";

export default defineTool({
  description: `Where ${agentName()}'s custom email domain stands: verification status, which DNS records are still missing or wrong, and the current address. The moment the domain verifies, this switches the address onto it. Also the tool to reach for when a connected domain seems stuck - it re-kicks AgentMail's verification when that is what's needed.`,
  inputSchema: z.object({}),
  async execute() {
    const state = await checkEmailDomain();
    if (!state.connected) {
      return {
        connected: false as const,
        emailAddress: state.emailAddress,
        note: "No custom domain is connected; the address lives on agentmail.to. Use connect_email_domain to change that.",
      };
    }
    return {
      connected: true as const,
      domain: state.domain,
      status: state.status,
      addressOnDomain: state.active,
      emailAddress: state.emailAddress,
      dnsRecords: (state.records ?? []).map((record) => ({
        type: record.type,
        name: record.name,
        value: record.priority !== undefined ? `${record.priority} ${record.value}` : record.value,
        status: record.status,
      })),
    };
  },
});
