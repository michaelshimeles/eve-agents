import { Exit } from "effect";

import { verifyCompanyConnect } from "@/agent/lib/effect/agentcard";
import { runtime } from "@/agent/lib/effect/runtime";
import { agentcardFailure } from "@/lib/agentcard-http";
import { requireCardAdmin } from "@/lib/card-auth";
import { requireWebAuth } from "@/lib/web-auth";

// Company mode, step two: the code the owner read out of his email, traded
// for the grant the agent then spends with. Admin-gated (lib/card-auth.ts)
// so an anonymous visitor cannot burn or brute-force the pending attempt.

export async function POST(request: Request): Promise<Response> {
  const denied = requireWebAuth(request) ?? requireCardAdmin(request);
  if (denied) return denied;

  let code = "";
  try {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body.code === "string") code = body.code.trim();
  } catch {
    // Fall through to the empty-code answer.
  }
  if (code.length === 0) {
    return new Response('Send the code from the email as {"code": "..."}.', { status: 400 });
  }

  const exit = await runtime.runPromiseExit(verifyCompanyConnect(code));
  if (Exit.isFailure(exit)) return agentcardFailure(exit.cause);
  return Response.json({ connected: true });
}
