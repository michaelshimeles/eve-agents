import { Exit } from "effect";

import {
  AGENTCARD_TERMS_VERSION,
  AGENTCARD_DASHBOARD_URL,
  agentcardStatus,
  disconnectAgentcard,
} from "@/agent/lib/effect/agentcard";
import { runtime } from "@/agent/lib/effect/runtime";
import { agentcardFailure } from "@/lib/agentcard-http";
import { cardAuthState, requireCardAdmin } from "@/lib/card-auth";
import { requireWebAuth } from "@/lib/web-auth";

// Whether the agent currently holds an Agentcard grant (GET), and giving it
// up (DELETE). Connecting always happens in place with a one-time code.

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const exit = await runtime.runPromiseExit(agentcardStatus());
  if (Exit.isFailure(exit)) return agentcardFailure(exit.cause);

  return Response.json({
    ...exit.value,
    dashboardUrl: AGENTCARD_DASHBOARD_URL,
    termsVersion: AGENTCARD_TERMS_VERSION,
    ...cardAuthState(request),
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = requireWebAuth(request) ?? requireCardAdmin(request);
  if (denied) return denied;

  const exit = await runtime.runPromiseExit(disconnectAgentcard());
  if (Exit.isFailure(exit)) return agentcardFailure(exit.cause);
  return Response.json({ ok: true, connected: false });
}
