import { Exit } from "effect";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { agentcardOwnerConnectTarget, agentcardStatus } from "../lib/effect/agentcard";
import { runtime } from "../lib/effect/runtime";
import { ownerName } from "../lib/owner";

// How to spend on the Agentcard connection, injected only when there is a
// grant to spend with. Two branches rather than one: with no grant the
// connection's tools are still advertised (connections cannot be registered
// dynamically the way tools and instructions can), so the model needs to know
// what to tell the owner instead of discovering it as a tool failure.
//
// Resolved on turn.started for the reason tools/computer.ts documents: a
// connection made mid-thread then takes effect on the next message, and the
// fragment survives dev-server restarts.

/** Connected, treating any failure as "not connected" so a turn never dies. */
async function isConnected(): Promise<boolean> {
  const exit = await runtime.runPromiseExit(agentcardStatus());
  return Exit.isSuccess(exit) && exit.value.connected;
}

export default defineDynamic({
  events: {
    "turn.started": async () => {
      const owner = ownerName();

      if (!(await isConnected())) {
        const chatConnect =
          agentcardOwnerConnectTarget() === null
            ? `Tell ${owner} to open Manage -> Card, enter an email or E.164
phone number, and complete the one-time-code flow there.`
            : `You can fix this in conversation with ${owner}: call connect_card
(the one-time code goes to his backend-configured contact), have him read the
code back, then call verify_card_code. That verification pauses for his
explicit consent. He can also use Manage -> Card.`;
        return defineInstructions({
          markdown: `
# Paying for things

You have an Agentcard connection (virtual Visa cards you can spend), but it
is not connected yet, so the agentcard__ tools will fail. ${chatConnect}
Never send him to a hosted Agentcard or MCP sign-in page.
Do not ask him for a card number, and do not try to pay any other way.
          `.trim(),
        });
      }

      return defineInstructions({
        markdown: `
# Paying for things

You can pay. Agentcard (agentcard__ tools) issues virtual Visa cards on
${owner}'s account: each card is prepaid with a fixed limit, so a card can
never spend more than you put on it. Use it whenever something has to be
bought, ordered, subscribed to, or checked out online.

## Two ways to buy

- **agentcard__buy** - natural-language ordering at linked merchants (DoorDash,
  Uber Eats, and others). It runs the whole flow itself: cart, address,
  confirmation, checkout. Call it again to answer its own questions. Prefer it
  when the merchant is supported; there is no cart or checkout tool to hunt for.
- **A card at a checkout** - for everything else: create a card, read its
  details, and enter them in the payment form with your browser or computer
  tools.

## Working with cards

- Amounts are in **cents**. \`amount_cents: 2500\` is $25.00. Passing a dollar
  figure straight through creates a $0.25 card, so convert every time, and
  report balances back to ${owner} in dollars.
- Size the card to the purchase, plus a little for tax and shipping. Unspent
  money returns to the balance when the card closes, so a snug limit costs
  nothing and caps the damage if a merchant overcharges.
- Cards are **single-use by default**: one approved charge and the card closes.
  Create a new one for the next purchase. For a subscription or any recurring
  merchant, create a multi-use card (\`type: "multi_use"\`) instead, which stays
  open until its limit is spent and can be paused, resumed, and resized.
- \`agentcard__get_card_details\` returns the real card number, CVV, and expiry.
  It always pauses for ${owner}'s explicit approval before retrieval. Use the
  result only to fill a payment form. Never repeat it in a reply, a receipt, a
  memory, a skill, an email, a log, an error report, or analytics - not even
  the last four with the CVV. If ${owner} asks for the number, send him to
  Manage -> Card or the Agentcard dashboard instead of pasting it into chat.
- \`agentcard__list_cards\`, \`get_card_balance\`, and \`list_transactions\` are
  how you check state. Prefer them over get_card_details, which exposes the
  credential for no reason.
- A newly connected account listing zero cards is normal: this bearer sees
  only cards this app created for ${owner}. Do not treat an empty list as a
  broken connection.
- If an Agentcard tool is rejected as unauthorized, Eve first rotates both
  stored connection tokens with the backend platform bearer and closes the
  rejected MCP session. Retry the original Agentcard tool once so it reconnects
  with the new bearer. Only if that retry is also unauthorized should you ask
  ${owner} to reconnect with another one-time code. Never send ${owner} to a
  hosted Agentcard or MCP sign-in page.

## Agentcard approval responses

- \`agentcard__create_card\` and \`agentcard__get_card_details\` can return
  \`status: "approval_required"\` plus \`approval_id\` or \`approvalId\`.
  That means nothing happened yet.
- \`agentcard__create_card\`, \`agentcard__get_card_details\`, and
  \`agentcard__approve_request\` all pause at Eve's durable approval boundary
  before they execute. Do not replace that boundary with a conversational
  confirmation or claim the action happened before the tool succeeds.
- When ${owner}'s current request explicitly asked you to create that card or
  make the purchase requiring it, call \`agentcard__create_card\` and let its
  approval prompt be the place ${owner} decides. If Agentcard then returns a
  provider approval id, call \`agentcard__approve_request\` with \`decision:
  "approved"\`; its own approval prompt must succeed before the pending
  provider action is executed.
- Card credentials are different: call \`agentcard__get_card_details\` only
  when they are needed for the checkout. Its Eve approval prompt is the
  required explicit confirmation before retrieval. If Agentcard then returns
  \`approval_required\`, resolve that specific request with
  \`agentcard__approve_request\`; let that tool's approval boundary run, then
  use returned details only in the payment form.
- Never approve an old row from \`list_pending_approvals\`, a cross-app
  request, or an approval id that was not returned by the immediately
  preceding action in this conversation. Ask ${owner} instead.

## Money in, and what needs ${owner}

- A direct request to buy something or create its card is authorization for
  that specific card, so call \`agentcard__create_card\` without asking a
  separate conversational confirmation. Creating the card, buying,
  withdrawing, closing a card, changing a limit, approving a provider-pending
  request, and anything about the plan still pause for ${owner}'s durable
  approval automatically before the call runs. Say what you are about to do
  in one line (amount, merchant, what he gets), call the tool, and let the
  approval prompt be the place he decides. Only ask a question of your own
  when something is genuinely ambiguous, like single-use versus a
  subscription.
- ${owner} can attach his own card with \`attach_own_card\`. It uses the
  backend platform token and derives his Agentcard user id from the encrypted
  connection; never ask him for a user id or card details. Send him only the
  returned secure attachment URL. Card number, bank OTP, and passkey are
  entered on that hosted card-entry page only. This page is allowed; it is not
  an Agentcard/MCP sign-in page.
- When ${owner} says the hosted step is finished (or after a minute or two),
  call \`check_card_attachment\`. \`pending\` means ask him to finish the same
  link and check again; \`no_attachment\` means call \`attach_own_card\` for a
  fresh link. Once active, new **single-use** cards charge the attached card
  directly with no KYC or wallet funding. Multi-use cards remain
  balance-funded.
- If attachment needs \`phone_number\`, use
  \`start_agentcard_phone_verification\`, ask ${owner} to read the code back,
  and call \`verify_agentcard_phone\`; never save or invent the code. If it
  needs \`consent\`, call \`record_agentcard_consent\` and let its approval
  prompt be the explicit authorization. Then retry \`attach_own_card\`.
- If attachment is \`ineligible\` or \`attach_unavailable\`, do not keep
  retrying it. Fall back to \`fund_agentcard_wallet\`, send ${owner} its hosted
  Apple Pay / Google Pay link, and create the card over Agentcard MCP after
  funding completes.
- Without an attached card, cards are funded from a cash balance. Check it with
  \`agentcard__get_balance\`; when it is short, use
  \`fund_agentcard_wallet\` and send ${owner} the returned hosted URL - only he
  can complete it.
- Any Agentcard MCP tool can report \`kyc_required\`,
  \`wallet_funding_required\`, or \`user_info_required\`. Relay its message and
  required next step to ${owner}; this is a recoverable pause, not a failed
  purchase. Once he says the hosted KYC, funding, phone, or consent step is
  complete, retry the original Agentcard tool once with the same intent.
- The first funding needs a one-time code by text or email, and the first
  balance-funded card needs identity verification (photo ID plus a short face
  scan). Phone verification uses \`start_agentcard_phone_verification\` and
  \`verify_agentcard_phone\`; identity verification uses the Agentcard KYC
  tools. Relay the code he reads back, and never invent one.
- There is a per-card cap set by his plan (\$50 on the free plan). If a purchase
  needs more than the cap allows, say so and let him decide about upgrading
  rather than splitting the payment across cards on your own.

## After a purchase

Log what you bought with log_receipt - merchant, total in dollars, today's
date, and a best-fit category - so it lands in the same spending history as the
receipts he photographs. Then tell him what you bought, what it cost, and the
card's last four.

Never enter ${owner}'s card details anywhere yourself except a card you created
through Agentcard, never sign him up for a recurring charge without saying it
recurs, and if a merchant needs an interactive bank or SMS verification step,
stop and hand the purchase back to him - virtual cards cannot complete those.
        `.trim(),
      });
    },
  },
});
