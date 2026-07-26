import { Cause, Exit } from "effect";

import {
  AGENTCARD_DASHBOARD_URL,
  AgentcardError,
  agentcardStatus,
  describeAgentcardError,
  disconnectAgentcard,
} from "@/agent/lib/effect/agentcard";
import { runtime } from "@/agent/lib/effect/runtime";
import { requireWebAuth } from "@/lib/web-auth";

// Whether the agent currently holds an Agentcard grant (GET), and giving it up
// (DELETE). Establishing one is a browser redirect, so it lives in
// ./connect and ./callback instead.

/** Maps a failed program to a status code the panel can act on. */
function failure(cause: Cause.Cause<unknown>): Response {
  const error = Cause.squash(cause);
  if (error instanceof AgentcardError) {
    const status = error.reason === "no_database" ? 503 : 502;
    return new Response(describeAgentcardError(error), { status });
  }
  return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const exit = await runtime.runPromiseExit(agentcardStatus());
  if (Exit.isFailure(exit)) return failure(exit.cause);
  return Response.json({ ...exit.value, dashboardUrl: AGENTCARD_DASHBOARD_URL });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const exit = await runtime.runPromiseExit(disconnectAgentcard());
  if (Exit.isFailure(exit)) return failure(exit.cause);
  return Response.json({ ok: true, connected: false });
}
