import { Exit } from "effect";

import { startCompanyConnect } from "@/agent/lib/effect/agentcard";
import { runtime } from "@/agent/lib/effect/runtime";
import { agentcardFailure } from "@/lib/agentcard-http";
import { requireCardAdmin } from "@/lib/card-auth";
import { requireWebAuth } from "@/lib/web-auth";

// Company mode, step one: email a one-time code to the owner's configured
// address. The address comes from env alone — this route takes no body, so
// nothing a caller sends can redirect where the code goes. Admin-gated
// (lib/card-auth.ts) so an anonymous visitor cannot spam the owner with
// codes or replace the attempt he is in the middle of completing.

export async function POST(request: Request): Promise<Response> {
  const denied = requireWebAuth(request) ?? requireCardAdmin(request);
  if (denied) return denied;

  const exit = await runtime.runPromiseExit(startCompanyConnect());
  if (Exit.isFailure(exit)) return agentcardFailure(exit.cause);
  return Response.json({ expiresAt: exit.value.expiresAt });
}
