import { Cause, Exit } from "effect";

import {
  AgentcardError,
  beginAgentcardAuthorization,
  describeAgentcardError,
} from "@/agent/lib/effect/agentcard";
import { runtime } from "@/agent/lib/effect/runtime";
import { AGENTCARD_CALLBACK_PATH } from "@/lib/agentcard-callback";
import { requestOrigin } from "@/lib/app-url";
import { requireWebAuth } from "@/lib/web-auth";

// Step one of connecting Agentcard: register a client for this origin if
// needed, then send the owner's browser to Agentcard to sign in. A redirect
// (not JSON) so the flow works from a plain link and lands back on ./callback
// in the same tab.

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const redirectUri = `${requestOrigin(request)}${AGENTCARD_CALLBACK_PATH}`;
  const exit = await runtime.runPromiseExit(beginAgentcardAuthorization(redirectUri));

  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    const message =
      error instanceof AgentcardError
        ? describeAgentcardError(error)
        : error instanceof Error
          ? error.message
          : String(error);
    // Failing back into the panel keeps the owner in one place; the alternative
    // is a bare error page with no way onward.
    return Response.redirect(
      `${requestOrigin(request)}/manage?card=error&message=${encodeURIComponent(message)}`,
      302,
    );
  }

  return Response.redirect(exit.value.url, 302);
}
