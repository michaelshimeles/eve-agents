import { Schema } from "effect";
import { defineTool } from "eve/tools";

import { verifyAgentcardPhone } from "../lib/effect/agentcard";
import { runTool } from "../lib/effect/runtime";
import { toolSchema } from "../lib/effect/tool-schema";
import { ownerOnly } from "../lib/owner-gate";

const Input = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(12)).annotate({
    description: "The one-time phone code the owner read back.",
  }),
  phone_number: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^\+[1-9]\d{7,14}$/),
      Schema.isMaxLength(16),
    ).annotate({
      description:
        "The same E.164 phone number supplied at start. Omit when Agentcard used a phone already on file.",
    }),
  ),
});

export default defineTool({
  approval: ownerOnly,
  description:
    "Verify the connected owner's Agentcard phone code. If a phone_number was supplied when the code was sent, pass the exact same number here. On invalid_code, let the owner retry; on expired/no_code, start again. Never save the code.",
  inputSchema: toolSchema(Input),
  async execute({ code, phone_number }) {
    await runTool(
      verifyAgentcardPhone({
        code: code.trim(),
        ...(phone_number === undefined ? {} : { phoneNumber: phone_number }),
      }),
    );
    return "The owner's phone is verified for 60 days. Retry attach_own_card.";
  },
});
