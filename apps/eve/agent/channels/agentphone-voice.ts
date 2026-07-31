import { POST, defineChannel } from "eve/channels";

import {
  AGENTPHONE_SIGNATURE_HEADER,
  AGENTPHONE_TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../lib/agentphone-signature";
import { parseVoice, voiceAuth, voiceResponse } from "../lib/agentphone-voice-stream";
import { phoneCallCursor, verifiedPhone } from "../lib/effect/agentphone";
import { runTool } from "../lib/effect/runtime";

// Live phone calls, over AgentPhone.
//
// This channel owns voice *sessions* — their continuation-token namespace and
// per-turn state — and answers synchronously: AgentPhone's voice webhook wants
// newline-delimited JSON in the response body of the inbound request, and its
// TTS speaks on the first chunk.
//
// Two ways in, both landing on the same logic:
//
//   /eve/v1/agentphone/inbound  the project-wide webhook, owned by
//                               agent/channels/agentphone.ts. AgentPhone
//                               registers exactly one callback per project and
//                               sends every event to it, so that route
//                               recognizes `channel: "voice"` and hands the
//                               transcript here through `receive`.
//   /eve/v1/agentphone/voice    this route. It is what registers the channel
//                               with the framework (a channel with no routes
//                               is not registered, and `receive` then cannot
//                               resolve it), and it is a valid target if you
//                               ever point an agent-scoped webhook at it.
//
// Voice is a separate channel from texting because the delivery models differ:
// a text turn delivers through `message.completed` by sending an SMS, which on
// a call would text the caller mid-conversation instead of speaking. Voice has
// no event handlers at all — its delivery *is* the HTTP response.
//
// Sessions are keyed by call id, so one call is one session and Ruth remembers
// what was said earlier in it.

export interface VoiceState {
  /** The call this session belongs to; every chunk is scoped to it. */
  callId: string | null;
  /** The caller, for attribution. Never proof — caller ID is spoofable. */
  from: string | null;
}

export default defineChannel<
  VoiceState,
  { state: VoiceState },
  { callId?: string; from?: string },
  { callId: string | null; from: string | null }
>({
  state: { callId: null, from: null },

  context(state) {
    return { state };
  },

  metadata(state) {
    return { callId: state.callId, from: state.from };
  },

  routes: [
    POST("/eve/v1/agentphone/voice", async (req, { send }) => {
      const phone = await runTool(verifiedPhone()).catch(() => null);
      if (phone === null) {
        return Response.json({ error: "no phone provisioned" }, { status: 503 });
      }

      // Signature verification needs the exact bytes; parse only after it holds.
      const body = await req.text();
      const verified = verifyWebhookSignature({
        secret: phone.webhookSecret,
        timestamp: req.headers.get(AGENTPHONE_TIMESTAMP_HEADER),
        signature: req.headers.get(AGENTPHONE_SIGNATURE_HEADER),
        rawBody: body,
      });
      if (!verified.ok) {
        console.error(`AgentPhone voice signature rejected: ${verified.reason}`);
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return Response.json({ error: "malformed body" }, { status: 400 });
      }

      const voice = parseVoice(parsed);
      if (voice === null) return Response.json({ ok: true, ignored: "event" });
      // A finished call needs no reply: the transcript already lives in that
      // call's session history, because every turn ran against it.
      if (voice.event === "agent.call_ended") return Response.json({ ok: true });
      if (voice.transcript.trim().length === 0) {
        return Response.json({ ok: true, ignored: "empty" });
      }

      const cursor = await runTool(phoneCallCursor(voice.callId)).catch(() => 0);
      const session = await send(voice.transcript, {
        auth: voiceAuth(voice, phone.ownerNumber),
        continuationToken: voice.callId,
        state: { callId: voice.callId, from: voice.from },
      });

      return await voiceResponse({ session, callId: voice.callId, cursor });
    }),
  ],

  async receive(input, { send }) {
    const callId = typeof input.target.callId === "string" ? input.target.callId.trim() : "";
    if (callId.length === 0) {
      throw new Error("agentphone-voice receive requires target.callId.");
    }
    const from = typeof input.target.from === "string" ? input.target.from : null;
    return send(input.message, {
      auth: input.auth,
      continuationToken: callId,
      state: { callId, from },
    });
  },

  // Deliberately empty. Delivery is the streamed HTTP response, so a
  // message.completed handler here would speak every reply twice.
  events: {},
});
