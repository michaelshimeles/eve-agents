import { Cause } from "effect";

import { AgentcardError, describeAgentcardError } from "@/agent/lib/effect/agentcard";

/**
 * Maps a failed Agentcard program to a Response the panel can act on:
 * missing prerequisites are 503, caller mistakes (wrong mode, dead code)
 * are 400, provider refusals are 502.
 */
export function agentcardFailure(cause: Cause.Cause<unknown>): Response {
  const error = Cause.squash(cause);
  if (error instanceof AgentcardError) {
    const status =
      error.reason === "no_database" || error.reason === "not_configured"
        ? 503
        : error.reason === "wrong_mode" || error.reason === "authorization_state"
          ? 400
          : 502;
    return new Response(describeAgentcardError(error), { status });
  }
  return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
}
