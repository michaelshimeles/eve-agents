import { Schema } from "effect";
import { defineTool } from "eve/tools";

import { verifyCompanyConnect } from "../lib/effect/agentcard";
import { runTool } from "../lib/effect/runtime";
import { toolSchema } from "../lib/effect/tool-schema";
import { ownerOnly } from "../lib/owner-gate";

const Input = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(12)).annotate({
    description: "The one-time code the owner read back from the connect email.",
  }),
});

export default defineTool({
  approval: ownerOnly,
  description:
    "Finish connecting the owner's Agentcard (company mode) with the one-time code he read back from his email. On success the agentcard__ tools work immediately.",
  inputSchema: toolSchema(Input),
  async execute({ code }) {
    await runTool(verifyCompanyConnect(code.trim()));
    return "Agentcard is connected. Cards can be created and purchases made (with the owner's approval on each).";
  },
});
