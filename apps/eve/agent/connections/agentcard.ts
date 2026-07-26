import { defineMcpClientConnection } from "eve/connections";

import { agentcardAccessToken, agentcardMcpUrl } from "../lib/effect/agentcard";
import { runTool } from "../lib/effect/runtime";

// Agentcard: the agent's own means of payment. It issues virtual Visa cards
// with a fixed spend limit, drawn from the owner's cash balance or minted
// against a card he attached, plus a conversational `buy` surface that orders
// from linked merchants end to end.
//
// The credential is app-scoped on purpose: one Agentcard account (the owner's)
// backs every surface, so a card works the same from web chat, Telegram,
// inbound email, and a fired reminder. agent/lib/effect/agentcard.ts explains
// why that beats eve's user-scoped OAuth strategies here, and holds the grant
// the owner establishes under Manage -> Card.
//
// Not connected yet is a normal state: getToken fails with a sentence telling
// the model to send the owner to Manage -> Card, which is more useful than
// hiding the capability (connections, unlike tools and instructions, cannot be
// registered dynamically).

/**
 * Bare tool names that move money, expose a commitment, or cannot be undone.
 * Everything else the server exposes reads state (balances, transactions,
 * cards, plan) or hands the owner a link he completes himself (add_funds,
 * attach_card, KYC), which needs no gate.
 */
const NEEDS_APPROVAL = new Set([
  // Spending: a new card draws real money out of the balance.
  "create_card",
  // Purchases.
  "buy",
  "buy_checkout",
  "surprise_me",
  "manage_subscription",
  // Moving money off the account.
  "withdraw",
  "create_withdrawal_recipient",
  // Irreversible, or changes a limit the owner set.
  "close_card",
  "update_card_limit",
  "remove_attached_card",
  "revoke_connection",
  "link_account",
  // Billing.
  "upgrade_plan",
  "cancel_plan",
  // Deciding an approval request is the owner's call, never the agent's.
  "approve_request",
]);

/** Connection tools arrive as `agentcard__<tool>`; compare the bare name. */
function bareName(qualified: string): string {
  const separator = qualified.lastIndexOf("__");
  return separator === -1 ? qualified : qualified.slice(separator + 2);
}

export default defineMcpClientConnection({
  url: agentcardMcpUrl(),
  description:
    "Agentcard: the agent's own payment method. Create virtual Visa cards with a fixed spending limit and get their number, expiry, and CVV to pay at any online checkout; read the cash balance, card balances, and transactions; send the owner a link to add funds or attach his own Visa; and order from linked merchants (DoorDash, Uber Eats, and others) end to end with the conversational buy tool. Use this whenever something has to be paid for, bought, ordered, subscribed to, or checked out.",
  auth: {
    // App-scoped: the single stored grant, refreshed when close to expiry.
    // eve caches per step and re-resolves once `expiresAt` passes.
    getToken: async () => {
      const { token, expiresAt } = await runTool(agentcardAccessToken());
      return expiresAt === null ? { token } : { token, expiresAt };
    },
  },
  approval: ({ toolName }) =>
    NEEDS_APPROVAL.has(bareName(toolName)) ? "user-approval" : "not-applicable",
});
