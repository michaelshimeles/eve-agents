import { Exit } from "effect";

import {
  parseAgentcardConnectTarget,
  startAgentcardConnect,
} from "@/agent/lib/effect/agentcard";
import { runtime } from "@/agent/lib/effect/runtime";
import { agentcardFailure } from "@/lib/agentcard-http";
import { requireCardAdmin } from "@/lib/card-auth";
import { requireWebAuth } from "@/lib/web-auth";

// Step one: send a one-time code to exactly one user-entered email or E.164
// phone number. The provider's connect_id is stored server-side and never
// returned to the browser.

export async function POST(request: Request): Promise<Response> {
  const denied = requireWebAuth(request) ?? requireCardAdmin(request);
  if (denied) return denied;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Parsed below as invalid input.
  }
  const target = parseAgentcardConnectTarget(body);
  if (target === null) {
    return Response.json(
      {
        error: {
          code: "invalid_request",
          message: "Send exactly one valid email or E.164 phone number.",
        },
      },
      { status: 400 },
    );
  }

  const exit = await runtime.runPromiseExit(startAgentcardConnect(target));
  if (Exit.isFailure(exit)) return agentcardFailure(exit.cause);
  return Response.json({
    codeSent: true,
    channel: exit.value.channel,
    expiresAt: exit.value.expiresAt,
  });
}
