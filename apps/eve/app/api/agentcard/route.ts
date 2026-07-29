import { Exit } from "effect";

import {
  AGENTCARD_DASHBOARD_URL,
  agentcardOwnerEmail,
  agentcardStatus,
  companyModeEnabled,
  disconnectAgentcard,
} from "@/agent/lib/effect/agentcard";
import { runtime } from "@/agent/lib/effect/runtime";
import { agentcardFailure } from "@/lib/agentcard-http";
import { cardAuthState, requireCardAdmin } from "@/lib/card-auth";
import { maskEmail } from "@/lib/mask-email";
import { requireWebAuth } from "@/lib/web-auth";

// Whether the agent currently holds an Agentcard grant (GET), and giving it
// up (DELETE). Establishing one depends on the mode the panel reads from
// this payload: personal is a browser redirect (./connect and ./callback),
// company is an emailed code (./connect/start and ./connect/verify).

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const exit = await runtime.runPromiseExit(agentcardStatus());
  if (Exit.isFailure(exit)) return agentcardFailure(exit.cause);

  const mode = companyModeEnabled() ? "company" : "personal";
  const email = agentcardOwnerEmail();
  // Auth state matters only to the company form; the personal flow has its
  // own consent screen on Agentcard's side.
  const auth =
    mode === "company"
      ? cardAuthState(request)
      : { authRequired: false, authConfigured: false };
  return Response.json({
    ...exit.value,
    dashboardUrl: AGENTCARD_DASHBOARD_URL,
    mode,
    ownerEmailMasked: mode === "company" && email !== null ? maskEmail(email) : null,
    ...auth,
  });
}

export async function DELETE(request: Request): Promise<Response> {
  // Company mode extends its connect gate to disconnect too: dropping the
  // grant every surface pays with is not for anonymous visitors. Personal
  // mode keeps its historical behavior — those deployments have no admin
  // token to enter, and reconnecting there walks Agentcard's own browser
  // consent anyway.
  const denied =
    requireWebAuth(request) ?? (companyModeEnabled() ? requireCardAdmin(request) : null);
  if (denied) return denied;

  const exit = await runtime.runPromiseExit(disconnectAgentcard());
  if (Exit.isFailure(exit)) return agentcardFailure(exit.cause);
  return Response.json({ ok: true, connected: false });
}
