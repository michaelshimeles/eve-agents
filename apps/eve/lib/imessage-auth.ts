import { adminGate } from "./admin-auth";

// The main web app is intentionally open, but an iMessage transcript contains
// private message bodies and provider/session identifiers. Give this read
// surface the same fail-closed, tab-scoped admin-token boundary used by the
// phone and Agentcard management routes.

export const IMESSAGE_ADMIN_HEADER = "x-imessage-admin-token";

const gate = adminGate({
  header: IMESSAGE_ADMIN_HEADER,
  envVar: "IMESSAGE_ADMIN_TOKEN",
  lockedMessage:
    "The iMessage conversation log is locked. Set IMESSAGE_ADMIN_TOKEN on this deployment, then enter it under Manage → iMessage.",
});

export function requireIMessageTranscriptAdmin(request: Request): Response | null {
  return gate.require(request);
}

export function imessageTranscriptAuthState(request: Request): {
  authRequired: boolean;
  authConfigured: boolean;
} {
  return gate.state(request);
}
