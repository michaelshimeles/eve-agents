import { Exit } from "effect";

import { verifyAgentcardConnect } from "@/agent/lib/effect/agentcard";
import { runtime } from "@/agent/lib/effect/runtime";
import { agentcardFailure } from "@/lib/agentcard-http";
import { requireCardAdmin } from "@/lib/card-auth";
import { requireWebAuthOr } from "@/lib/web-auth";

// Step two: verify the code, record consent, then encrypt and store the
// rotating connection token pair. Tokens never appear in this response.

export async function POST(request: Request): Promise<Response> {
  const denied = await requireWebAuthOr(request, () => requireCardAdmin(request));
  if (denied) return denied;

  let code = "";
  let consent = false;
  try {
    const body = (await request.json()) as { code?: unknown; consent?: unknown };
    if (typeof body.code === "string") code = body.code.trim();
    consent = body.consent === true;
  } catch {
    // Fall through to the empty-code answer.
  }
  if (code.length === 0 || code.length > 12) {
    return Response.json(
      {
        error: {
          code: "invalid_request",
          message: "Send a valid one-time code.",
        },
      },
      { status: 400 },
    );
  }

  const exit = await runtime.runPromiseExit(verifyAgentcardConnect({ code, consent }));
  if (Exit.isFailure(exit)) return agentcardFailure(exit.cause);
  return Response.json({ connected: true });
}
