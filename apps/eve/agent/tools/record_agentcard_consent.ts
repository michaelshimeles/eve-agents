import { defineTool } from "eve/tools";

import {
  AGENTCARD_TERMS_VERSION,
  recordAgentcardConsent,
} from "../lib/effect/agentcard";
import { runTool } from "../lib/effect/runtime";
import { EmptyToolInput, toolSchema } from "../lib/effect/tool-schema";
import { guestDenial } from "../lib/owner-gate";

export default defineTool({
  approval: (context) => guestDenial(context) ?? "user-approval",
  description: `Record the connected owner's Agentcard consent when attach_own_card reports consent is missing. Approval authorizes Ruth to act through Agentcard, accepts the Agentcard/card-issuer terms (${AGENTCARD_TERMS_VERSION}), and acknowledges that Crossmint may process payments under its Privacy Policy: https://www.crossmint.com/legal/privacy-policy`,
  inputSchema: toolSchema(EmptyToolInput),
  async execute() {
    await runTool(recordAgentcardConsent());
    return "Agentcard consent is recorded. Retry attach_own_card.";
  },
});
