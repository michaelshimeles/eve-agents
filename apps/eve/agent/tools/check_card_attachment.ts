import { defineTool } from "eve/tools";

import { agentcardAttachmentStatus } from "../lib/effect/agentcard";
import { runTool } from "../lib/effect/runtime";
import { EmptyToolInput, toolSchema } from "../lib/effect/tool-schema";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description:
    "Check whether the connected owner finished the secure Agentcard card-attachment link. Use when the owner says it is done, or after a minute or two. This never reads card details beyond brand and last four.",
  inputSchema: toolSchema(EmptyToolInput),
  async execute() {
    const result = await runTool(agentcardAttachmentStatus());
    switch (result.status) {
      case "active":
        return `Attached: ${result.card.brand ?? "card"} ending ${result.card.last4 ?? "unknown"}. New single-use Agentcard cards now charge it directly, without KYC or wallet funding.`;
      case "pending":
        return "The attachment is still pending. Ask the owner to finish the secure link, then call check_card_attachment again.";
      case "ineligible":
        return `This card is ineligible (${result.reason}): ${result.message} Fall back to fund_agentcard_wallet, then create the card over Agentcard MCP.`;
      case "no_attachment":
        return "There is no attachment in progress. Call attach_own_card to create a fresh link.";
      case "unavailable":
        return `${result.message} Fall back to fund_agentcard_wallet, then create the card over Agentcard MCP.`;
    }
  },
});
