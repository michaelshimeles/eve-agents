import { defineTool } from "eve/tools";

import { startAgentcardAttachment } from "../lib/effect/agentcard";
import { runTool } from "../lib/effect/runtime";
import { EmptyToolInput, toolSchema } from "../lib/effect/tool-schema";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description:
    "Start the backend-only Agentcard attach flow for the connected owner. Returns the secure hosted card-entry link to send to the owner, or says the card is already attached. Never ask for or accept card details in chat. If prerequisites are missing, use the dedicated Agentcard consent or phone-verification tools, then retry.",
  inputSchema: toolSchema(EmptyToolInput),
  async execute() {
    const result = await runTool(startAgentcardAttachment());
    switch (result.status) {
      case "active":
        return `The owner's ${result.card.brand ?? "card"} ending ${result.card.last4 ?? "unknown"} is already attached. New single-use cards can charge it directly.`;
      case "pending":
        return `Send the owner this secure Agentcard card-entry link as a plain URL: ${result.attachUrl}\nIt expires at ${result.expiresAt}. Card details, the bank code, and the passkey belong on that hosted page only—never ask for them in chat. When the owner says it is finished, call check_card_attachment.`;
      case "ineligible":
        return `This card cannot be attached (${result.reason}): ${result.message} Fall back to fund_agentcard_wallet, then create the card over Agentcard MCP.`;
      case "user_info_required": {
        const missing =
          result.missingFields.length === 0
            ? "phone_number or consent"
            : result.missingFields.join(", ");
        return `Agentcard needs these prerequisites before attachment: ${missing}. ${result.message} Use start_agentcard_phone_verification + verify_agentcard_phone for phone_number, or record_agentcard_consent for consent, then call attach_own_card again.`;
      }
      case "unavailable":
        return `${result.message} Fall back to fund_agentcard_wallet, then create the card over Agentcard MCP.`;
    }
  },
});
