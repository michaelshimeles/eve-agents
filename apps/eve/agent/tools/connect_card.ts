import { Schema } from "effect";
import { defineTool } from "eve/tools";

import { startCompanyConnect } from "../lib/effect/agentcard";
import { runTool } from "../lib/effect/runtime";
import { toolSchema } from "../lib/effect/tool-schema";
import { ownerOnly } from "../lib/owner-gate";

// No inputs on purpose: the code goes to AGENTCARD_OWNER_EMAIL, full stop.
// A model that could pass an address here could be injected into aiming the
// credential-granting code at an attacker's inbox.

export default defineTool({
  approval: ownerOnly,
  description:
    "Start connecting the owner's Agentcard (company mode): emails a one-time code to the owner's configured address. Use when Agentcard is not connected, or to reconnect after the grant expires. Follow up with verify_card_code once the owner reads the code back. Fails in personal mode - send the owner to Manage -> Card instead.",
  inputSchema: toolSchema(Schema.Struct({})),
  async execute() {
    const { expiresAt } = await runTool(startCompanyConnect());
    return expiresAt === null
      ? "Code sent to the owner's email on file. Ask him to read it back, then call verify_card_code."
      : `Code sent to the owner's email on file (valid until ${expiresAt}). Ask him to read it back, then call verify_card_code.`;
  },
});
