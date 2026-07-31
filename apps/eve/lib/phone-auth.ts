import { adminGate } from "./admin-auth";

// Authorization for phone management.
//
// These operations are not like the rest of the manage surface: they rotate an
// API credential, buy a number that bills monthly, release the line the agent
// answers on, and decide whose texts count as the owner's. The app as a whole
// is unauthenticated by design (`lib/web-auth.ts` no-ops and the eve channel
// admits anonymous callers), so this route brings its own gate rather than
// inheriting one that permits everybody. The rules live in `lib/admin-auth.ts`.

export const PHONE_ADMIN_HEADER = "x-phone-admin-token";

const gate = adminGate({
  header: PHONE_ADMIN_HEADER,
  envVar: "AGENTPHONE_ADMIN_TOKEN",
  lockedMessage:
    "Phone management is locked. Set AGENTPHONE_ADMIN_TOKEN on this deployment, then enter it here to provision, release, or change the key.",
});

/** Whether this deployment has an admin token at all. */
export function phoneAdminConfigured(): boolean {
  return gate.configured();
}

/**
 * Guards a state-changing phone request. Returns a `Response` to send when the
 * caller may not proceed, or `null` when they may.
 */
export function requirePhoneAdmin(request: Request): Response | null {
  return gate.require(request);
}

/** What the panel needs to know before it offers any of the controls. */
export function phoneAuthState(request: Request): {
  authRequired: boolean;
  authConfigured: boolean;
} {
  return gate.state(request);
}
