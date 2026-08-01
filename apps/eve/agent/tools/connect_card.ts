import { defineTool } from "eve/tools";

import {
  agentcardOwnerConnectTarget,
  startAgentcardConnect,
} from "../lib/effect/agentcard";
import { runTool } from "../lib/effect/runtime";
import { EmptyToolInput, toolSchema } from "../lib/effect/tool-schema";
import { ownerOnly } from "../lib/owner-gate";

// No inputs on purpose: the code goes to the one env-pinned owner contact,
// never an address selected by the model.

export default defineTool({
  approval: ownerOnly,
  description:
    "Send a one-time Agentcard connection code to the owner's backend-configured email or phone. Use when Agentcard is not connected, or to reconnect after the grant expires. Follow up with verify_card_code once the owner reads the code back.",
  inputSchema: toolSchema(EmptyToolInput),
  async execute() {
    const target = agentcardOwnerConnectTarget();
    if (target === null) {
      throw new Error(
        "Set exactly one of AGENTCARD_OWNER_EMAIL or AGENTCARD_OWNER_PHONE before connecting from chat. The owner can connect from Manage -> Card without either env var.",
      );
    }
    const { expiresAt, channel } = await runTool(startAgentcardConnect(target));
    const destination = channel === "phone" ? "phone" : "email";
    return expiresAt === null
      ? `Code sent to the owner's ${destination} on file. Ask him to read it back, then call verify_card_code.`
      : `Code sent to the owner's ${destination} on file (valid until ${expiresAt}). Ask him to read it back, then call verify_card_code.`;
  },
});
