import { defineMcpClientConnection } from "eve/connections";
import type { Approval } from "eve/tools";

import {
  agentcardAccessToken,
  agentcardMcpUrl,
  refreshAgentcardAfterMcpUnauthorized,
} from "../lib/effect/agentcard";
import { runTool } from "../lib/effect/runtime";
import { guestDenial } from "../lib/owner-gate";

// Agentcard: the agent's own means of payment. It issues virtual Visa cards
// with a fixed spend limit, drawn from the owner's cash balance or minted
// against a card he attached, plus a conversational `buy` surface that orders
// from linked merchants end to end.
//
// The credential is app-scoped on purpose: one Agentcard account (the owner's)
// backs every surface, so a card works the same from web chat, Telegram,
// inbound email, and a fired reminder. agent/lib/effect/agentcard.ts explains
// why that beats eve's user-scoped OAuth strategies here. The backend-only
// Connect API establishes the grant with a one-time email or phone code; the
// token pair is stored encrypted under the connected Agentcard user id.
//
// Not connected yet is a normal state: getToken fails with a sentence telling
// the model to send the owner to Manage -> Card, which is more useful than
// hiding the capability (connections, unlike tools and instructions, cannot be
// registered dynamically).

/**
 * The reviewed read-only MCP calls that may run without interrupting the
 * owner. Registration remains dynamic, but approval is deliberately
 * fail-closed: every provider-added or renamed tool pauses for approval until
 * we have established that it cannot move money, mutate state, or reveal
 * credentials.
 */
const READ_ONLY_WITHOUT_APPROVAL = new Set([
  "get_instructions",
  "whoami",
  "get_balance",
  "list_cards",
  "get_card_balance",
  "list_transactions",
  "list_pending_approvals",
]);

/** Connection tools arrive as `agentcard__<tool>`; compare the bare name. */
function bareName(qualified: string): string {
  const separator = qualified.lastIndexOf("__");
  return separator === -1 ? qualified : qualified.slice(separator + 2);
}

/** Exported as a pure seam for the safety-policy tests. */
export function agentcardNeedsApproval(toolName: string): boolean {
  return !READ_ONLY_WITHOUT_APPROVAL.has(bareName(toolName));
}

/** Owner/guest policy shared by the connection definition and direct tests. */
export const agentcardApproval: Approval = (ctx) =>
  guestDenial(ctx) ??
  (agentcardNeedsApproval(ctx.toolName) ? "user-approval" : "not-applicable");

/**
 * Eve resolves this provider once per active turn. Keeping the last bearer in
 * that resolver closure lets the 401 eviction hook identify the exact token
 * Agentcard rejected, without placing a token or MCP client in module-global
 * state. This app has one active owner grant; Eve still creates and closes the
 * standards-compliant Streamable HTTP client per agent session.
 */
export function agentcardAuthorization(
  readAccessToken: typeof readAgentcardAccessToken = readAgentcardAccessToken,
  refreshRejectedToken: typeof refreshRejectedAgentcardToken =
    refreshRejectedAgentcardToken,
) {
  return () => {
    let issuedToken: string | null = null;
    return {
      principalType: "app" as const,
      getToken: async () => {
        const result = await readAccessToken();
        issuedToken = result.token;
        return result.expiresAt === null
          ? { token: result.token }
          : { token: result.token, expiresAt: result.expiresAt };
      },
      evict: async () => {
        const rejectedToken = issuedToken;
        issuedToken = null;
        if (rejectedToken !== null) {
          await refreshRejectedToken(rejectedToken);
        }
      },
    };
  };
}

async function readAgentcardAccessToken() {
  return runTool(agentcardAccessToken());
}

async function refreshRejectedAgentcardToken(rejectedAccessToken: string): Promise<void> {
  await runTool(refreshAgentcardAfterMcpUnauthorized(rejectedAccessToken));
}

export default defineMcpClientConnection({
  url: agentcardMcpUrl(),
  description:
    "Agentcard: the agent's own payment method. All tools are discovered dynamically from the connected user's MCP session. Create virtual Visa cards with a fixed spending limit and get their number, expiry, and CVV to pay at online checkout; read balances, cards, and transactions; attach or fund a payment source; and order from linked merchants end to end.",
  // Bearer-only, non-interactive auth. No OAuth discovery methods exist on
  // this provider, so Eve can never open Agentcard's hosted sign-in page.
  auth: agentcardAuthorization(),
  // Intentionally no `tools` allow/block filter: every current and future
  // tool returned by tools/list is registered for this user's MCP client.
  // Money is owner-only in code, not just in instructions: every Agentcard
  // tool — reads included, balances and transactions are his — is denied on
  // iMessage-group guest turns before the usual approval logic applies.
  approval: agentcardApproval,
});
