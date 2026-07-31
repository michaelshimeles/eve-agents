import { adminGate } from "./admin-auth";

// Authorization for the Agentcard company connect routes.
//
// Starting a connect emails the owner a credential-granting code, and
// verifying one rotates the payment grant every surface spends with. The app
// as a whole is unauthenticated by design (`lib/web-auth.ts` no-ops), so
// like phone management these routes bring their own gate rather than
// letting any visitor consume or replace the owner's pending sign-in. The
// rules live in `lib/admin-auth.ts`; the in-chat connect tools are gated
// separately (owner-only turns) and never pass through these routes.

export const CARD_ADMIN_HEADER = "x-card-admin-token";

const gate = adminGate({
  header: CARD_ADMIN_HEADER,
  envVar: "AGENTCARD_ADMIN_TOKEN",
  lockedMessage:
    "Card connection is locked. Set AGENTCARD_ADMIN_TOKEN on this deployment, then enter it here to connect or reconnect Agentcard.",
});

/** Whether this deployment has an admin token at all. */
export function cardAdminConfigured(): boolean {
  return gate.configured();
}

/**
 * Guards a company connect request. Returns a `Response` to send when the
 * caller may not proceed, or `null` when they may.
 */
export function requireCardAdmin(request: Request): Response | null {
  return gate.require(request);
}

/** What the panel needs to know before it offers the connect form. */
export function cardAuthState(request: Request): {
  authRequired: boolean;
  authConfigured: boolean;
} {
  return gate.state(request);
}
