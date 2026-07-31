import { Schema } from "effect";
import { defineTool } from "eve/tools";

import {
  AGENTCARD_TERMS_VERSION,
  verifyAgentcardConnect,
} from "../lib/effect/agentcard";
import { runTool } from "../lib/effect/runtime";
import { toolSchema } from "../lib/effect/tool-schema";
import { guestDenial } from "../lib/owner-gate";

const Input = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(12)).annotate({
    description: "The one-time code the owner read back from the connect email.",
  }),
});

export default defineTool({
  // The owner's approval is the explicit authorization recorded with
  // Agentcard after the code verifies. Guest turns remain denied in code.
  approval: (context) => guestDenial(context) ?? "user-approval",
  description:
    `Finish connecting the owner's Agentcard with the one-time code. Approval explicitly authorizes Ruth to access the account, accepts the applicable Agentcard and issuer terms (${AGENTCARD_TERMS_VERSION}), and acknowledges that Crossmint may process payments under its Privacy Policy: https://www.crossmint.com/legal/privacy-policy`,
  inputSchema: toolSchema(Input),
  async execute({ code }) {
    await runTool(verifyAgentcardConnect({ code: code.trim(), consent: true }));
    return "Agentcard is connected. Cards can be created and purchases made (with the owner's approval on each).";
  },
});
