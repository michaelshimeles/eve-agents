// Mints a short-lived OpenAI Realtime client secret for the voice orb. The
// real OPENAI_API_KEY never leaves the server; the browser only ever sees the
// ephemeral ek_ value, which expires minutes after the WebRTC handshake.
import { Cause, Exit } from "effect";

import { runtime } from "@/agent/lib/effect/runtime";
import { VoiceError, mintVoiceClientSecret } from "@/agent/lib/effect/voice";
import { requireWebAuth } from "@/lib/web-auth";

const STATUS: Record<VoiceError["reason"], number> = {
  not_configured: 404,
  openai: 502,
  timeout: 504,
};

// The orb speaks these to the user, so they stay short and human. The verbose
// provider detail goes to the server log instead of the caption bubble.
const MESSAGE: Record<VoiceError["reason"], string> = {
  not_configured: "Voice isn't set up — add an OpenAI API key",
  openai: "OpenAI wouldn't start a voice session",
  timeout: "OpenAI took too long to answer",
};

export async function POST(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const exit = await runtime.runPromiseExit(mintVoiceClientSecret());
  if (Exit.isSuccess(exit)) return Response.json(exit.value);
  const failure = Cause.squash(exit.cause);
  if (failure instanceof VoiceError) {
    console.error(`[voice] token mint failed: ${failure.message}`);
    return Response.json({ error: MESSAGE[failure.reason] }, { status: STATUS[failure.reason] });
  }
  console.error("[voice] token mint failed", failure);
  return Response.json({ error: "Voice session could not be created" }, { status: 500 });
}

export const maxDuration = 30;
