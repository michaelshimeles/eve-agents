import { defineTool } from "eve/tools";
import { z } from "zod";

import { connectEmailDomain } from "../lib/email-domain";
import { agentName, ownerName } from "../lib/owner";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description: `Put ${agentName()}'s email address on a custom domain ${ownerName()} owns (e.g. ruth@example.com instead of @agentmail.to). Registers the domain with AgentMail and returns the DNS records ${ownerName()} must add at his registrar. Nothing changes until the domain verifies: check_email_domain reports progress, and the address moves over automatically once it is verified. Requires a domain he actually controls, and a paid AgentMail plan.`,
  inputSchema: z.object({
    domain: z
      .string()
      .min(4)
      .max(253)
      .describe('The domain to connect, e.g. "example.com" (no scheme, no mailbox name).'),
  }),
  async execute({ domain }) {
    const state = await connectEmailDomain(domain);
    return {
      domain: state.domain,
      status: state.status,
      currentAddress: state.emailAddress,
      dnsRecords: (state.records ?? []).map((record) => ({
        type: record.type,
        name: record.name,
        value: record.priority !== undefined ? `${record.priority} ${record.value}` : record.value,
        status: record.status,
      })),
      nextStep: `Send ${ownerName()} the DNS records as a clear list (type, name, value) to add at his DNS provider. Verification usually completes within minutes of the records propagating, but can take up to 48 hours. Use check_email_domain later to see progress; the address switches automatically once verified.`,
    };
  },
});
