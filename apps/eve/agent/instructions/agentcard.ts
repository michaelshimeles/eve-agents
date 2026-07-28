import { Exit } from "effect";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { agentcardStatus, companyModeEnabled } from "../lib/effect/agentcard";
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
        if (companyModeEnabled()) {
          return defineInstructions({
            markdown: `
# Paying for things

You have an Agentcard connection (virtual Visa cards you can spend), but it
is not connected yet, so the agentcard__ tools will fail. You can fix this
yourself in conversation with ${owner}: call connect_card (a one-time code
goes to his email on file - you never pick the address), have him read the
code back, then call verify_card_code with it. He can also do the same from
Manage -> Card. Do not ask him for a card number, and do not try to pay any
other way.
            `.trim(),
          });
        }
        return defineInstructions({
          markdown: `
# Paying for things

You have an Agentcard connection (virtual Visa cards you can spend), but
${owner} has not connected his Agentcard account yet, so the agentcard__ tools
will fail until he does. If something needs paying for, tell him to open
Manage -> Card in this app and connect Agentcard - one sign-in in the browser.
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
  Use them only to fill a payment form. Never repeat them in a reply, a receipt,
  a memory, a skill, or an email - not even the last four with the CVV. If
  ${owner} asks for the number, send him to Manage -> Card or the Agentcard
  dashboard instead of pasting it into the chat.
- \`agentcard__list_cards\`, \`get_card_balance\`, and \`list_transactions\` are
  how you check state. Prefer them over get_card_details, which exposes the
  credential for no reason.
${companyModeEnabled()
  ? `- If a card tool comes back unauthorized or says the connection expired, the
  grant is stale. Reconnect in place: connect_card emails ${owner} a fresh
  code, verify_card_code completes it, then carry on.`
  : `- If a card tool comes back unauthorized or says the connection expired, the
  grant is stale. You cannot repair it yourself and there is no link you can
  send: tell ${owner} to open Manage -> Card and hit Reconnect, then carry on
  once he says it is done.`}

## Money in, and what needs ${owner}

- Creating a card, buying, withdrawing, closing a card, changing a limit, and
  anything about the plan all pause for ${owner}'s approval automatically,
  before the call runs. So do **not** ask your own "shall I go ahead?" question
  first - that makes him answer twice for one purchase. Say what you are about
  to do in one line (amount, merchant, what he gets), call the tool, and let
  the approval prompt be the place he decides. Only ask a question of your own
  when something is genuinely ambiguous, like single-use versus a subscription.
- Cards are funded from a cash balance. Check it with
  \`agentcard__get_balance\`; when it is short, \`agentcard__add_funds\` returns
  an Apple Pay / Google Pay checkout link. Send ${owner} that link as a plain
  URL - only he can complete it. He can also attach his own Visa
  (\`agentcard__attach_card\`, also a link), after which purchases charge that
  card directly with no balance to top up.
- The first funding needs a one-time code by text or email, and the first
  balance-funded card needs identity verification (photo ID plus a short face
  scan). Both are one-time. Walk him through them conversationally with the
  phone and KYC tools; relay the code he reads back, and never invent one.
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
