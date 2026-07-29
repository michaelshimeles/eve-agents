import { Cause, Exit } from "effect";

import {
  AgentcardError,
  completeAgentcardAuthorization,
  describeAgentcardError,
} from "@/agent/lib/effect/agentcard";
import { runtime } from "@/agent/lib/effect/runtime";
import { requestOrigin } from "@/lib/app-url";
import { requireWebAuth } from "@/lib/web-auth";

// Step two of connecting Agentcard: Agentcard redirects the owner here with an
// authorization code, which is exchanged for the grant the agent then spends
// with. Every outcome ends as a redirect back to the manage panel, which reads
// the `card` parameter and reports what happened.

function back(request: Request, params: Record<string, string>): Response {
  const url = new URL(`${requestOrigin(request)}/manage`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return Response.redirect(url.toString(), 302);
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const query = new URL(request.url).searchParams;

  // The owner cancelled, or Agentcard refused the request outright.
  const providerError = query.get("error");
  if (providerError !== null) {
    return back(request, {
      card: "error",
      message: query.get("error_description") ?? providerError,
    });
  }

  const code = query.get("code");
  const state = query.get("state");
  if (code === null || state === null) {
    return back(request, { card: "error", message: "Agentcard sent back an incomplete sign-in." });
  }

  const exit = await runtime.runPromiseExit(completeAgentcardAuthorization({ code, state }));
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    return back(request, {
      card: "error",
      message:
        error instanceof AgentcardError
          ? describeAgentcardError(error)
          : error instanceof Error
            ? error.message
            : String(error),
    });
  }

  return back(request, { card: "connected" });
}
