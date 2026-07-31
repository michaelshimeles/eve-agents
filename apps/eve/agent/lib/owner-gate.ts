import type { Approval, ApprovalContext } from "eve/tools";

// Code-enforced owner boundary for tools. iMessage group chats admit people
// other than the owner ("guests", labeled by agent/channels/imessage.ts with
// role: "guest" on the turn's auth). The group instructions already tell the
// model to refuse sensitive requests from guests, but instructions are not a
// security boundary — this approval policy is. It runs in the framework
// before `execute`, so a prompt-injected or non-compliant model still cannot
// reach an owner-only tool on a guest turn.
//
// Any future channel that admits non-owner callers should label them the same
// way (attributes.role = "guest") to inherit this gate.

/** The slice of session auth shared by approval and dynamic-resolver contexts. */
interface AuthCarrier {
  readonly session: {
    readonly auth: {
      readonly current: {
        readonly authenticator?: string;
        readonly principalId: string;
        readonly attributes: Readonly<Record<string, string | readonly string[]>>;
      } | null;
    };
  };
}

/** True when the active turn was started by a non-owner group participant. */
function isGuestTurn(ctx: AuthCarrier): boolean {
  const auth = ctx.session.auth.current;
  return auth !== null && auth.attributes.role === "guest";
}

/**
 * Guest check for dynamic tool/skill resolvers (`defineDynamic` events),
 * whose context carries the same session auth as tool approvals. Return
 * `null` from the resolver on guest turns so the tools are not advertised.
 */
export function isGuestResolve(ctx: AuthCarrier): boolean {
  return isGuestTurn(ctx);
}

/**
 * True for every iMessage group turn, including the owner's own messages.
 * Shared chats must never inherit the private DM/web memory profile merely
 * because the current speaker happens to be the owner.
 */
export function isSharedIMessageResolve(ctx: AuthCarrier): boolean {
  const auth = ctx.session.auth.current;
  return (
    auth?.authenticator === "imessage-router" &&
    auth.attributes.chat === "group"
  );
}

/**
 * Approval policy for owner-only tools: denies guest turns outright, stays
 * out of the way (`not-applicable`) for everyone else. Attach as
 * `approval: ownerOnly` on a `defineTool`, or compose it inside a
 * connection's approval function.
 */
export const ownerOnly: Approval = (ctx) => {
  const denied = guestDenial(ctx);
  return denied ?? "not-applicable";
};

/**
 * The denial for a guest turn, or null when the caller may proceed. For
 * composing with approval policies that have their own non-guest behavior.
 */
export function guestDenial(ctx: ApprovalContext): { type: "denied"; reason: string } | null {
  if (!isGuestTurn(ctx)) return null;
  // Audit trail: every blocked attempt is worth a log line.
  console.warn(`owner-gate: denied ${ctx.toolName} for an unauthorised guest turn`);
  return {
    type: "denied",
    reason:
      "This tool is owner-only, and the current message came from a group participant who is not the owner. Do not retry. Tell them the owner has to ask for this themselves.",
  };
}
