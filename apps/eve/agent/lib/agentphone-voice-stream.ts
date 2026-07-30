import type { Session } from "eve/channels";
import { type HandleMessageStreamEvent, isCurrentTurnBoundaryEvent } from "eve/client";

import { setPhoneCallCursor } from "./effect/agentphone";
import { runTool } from "./effect/runtime";

// Turns one eve turn into AgentPhone's voice response protocol.
//
// The provider's voice webhook is synchronous: it wants newline-delimited JSON
// written into the response body of the inbound request, and its TTS starts
// speaking on the first chunk. eve's session event stream is the bridge —
// `send()`/`receive()` return a Session without awaiting the turn, and
// `getEventStream()` tails it live — so this maps one onto the other.
//
// Lives in lib rather than in the channel because the single webhook the
// provider calls is owned by the text channel (one project, one callback URL),
// which hands voice events here.

/**
 * Ceiling on how long the response stays open. The provider's own webhook
 * timeout is configurable to 120s and we register 120s, so this has to fire
 * first — a turn that overruns must still close with speech rather than
 * letting the provider time out on silence.
 */
const TURN_BUDGET_MS = 105_000;

/** Spoken as soon as a turn needs tools, so the line is never dead. */
const HOLDING_LINE = "One moment.";

const NOTHING_HEARD = "Sorry, I didn't catch that.";
const TURN_FAILED = "Sorry, something went wrong on my end.";
const TOO_SLOW = "Sorry, that's taking me longer than expected. Could you say that again?";

export interface InboundVoice {
  readonly event: string;
  readonly callId: string;
  readonly from: string;
  readonly to: string;
  readonly direction: string;
  readonly transcript: string;
}

/** Reads a voice envelope, or null when this delivery is not one. */
export function parseVoice(raw: unknown): InboundVoice | null {
  if (raw === null || typeof raw !== "object") return null;
  const { event, channel, data } = raw as {
    event?: unknown;
    channel?: unknown;
    data?: unknown;
  };
  if (typeof event !== "string" || channel !== "voice") return null;
  if (data === null || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const callId = typeof record.callId === "string" ? record.callId : "";
  if (callId.length === 0) return null;
  return {
    event,
    callId,
    from: typeof record.from === "string" ? record.from : "",
    to: typeof record.to === "string" ? record.to : "",
    direction: typeof record.direction === "string" ? record.direction : "inbound",
    transcript: typeof record.transcript === "string" ? record.transcript : "",
  };
}

/**
 * The turn's auth. Caller ID is trivially spoofed, so it is attribution and
 * never proof: only a call Ruth placed to the owner's own number counts as the
 * owner. Everyone else is a guest, which keeps owner-only tools out of reach of
 * anyone who can dial a number and set a caller ID.
 */
export function voiceAuth(voice: InboundVoice, ownerNumber: string | null) {
  const isOwnerCall =
    voice.direction === "outbound" && ownerNumber !== null && voice.from === ownerNumber;
  return {
    authenticator: "agentphone-voice",
    principalType: "user" as const,
    principalId: `tel:${voice.from}`,
    attributes: {
      call_id: voice.callId,
      from: voice.from,
      to: voice.to,
      direction: voice.direction,
      channel: "voice",
      role: isOwnerCall ? "owner" : "guest",
    },
  };
}

/** One chunk of the voice protocol. */
interface VoiceChunk {
  text: string;
  /** Speak this but keep the turn open. The first chunk without it closes. */
  interim?: boolean;
  hangup?: boolean;
}

function encodeChunk(chunk: VoiceChunk): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(chunk)}\n`);
}

/**
 * Speech is spoken, not read, so markdown that renders invisibly on screen is
 * pronounced as punctuation over a phone. Strip the syntax, keep the words.
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|\*|_)/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Streams `session`'s current turn as a voice response body.
 *
 * `cursor` is where this call's stream was last read to. eve addresses events
 * by absolute index across the whole session, so turn two of a call would
 * replay turn one from zero without it.
 */
export async function voiceResponse(input: {
  readonly session: Session;
  readonly callId: string;
  readonly cursor: number;
}): Promise<Response> {
  const { session, callId, cursor } = input;
  const events = await session.getEventStream({ startIndex: cursor });

  let consumed = 0;
  let spoke = false;
  let turnId: string | null = null;
  let closed = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Records where this call's stream stopped. Awaited before the response
   * closes, never fire-and-forget: the provider sends the next utterance as
   * soon as this response completes, and a detached write that has not landed
   * yet leaves the next turn reading the old cursor and speaking this turn's
   * answer a second time.
   */
  const persistCursor = async (): Promise<void> => {
    try {
      await runTool(setPhoneCallCursor({ callId, cursor: cursor + consumed }));
    } catch (error) {
      console.error(`AgentPhone voice cursor write failed for ${callId}.`, error);
    }
  };

  /**
   * Ends the response exactly once, cursor first.
   *
   * `abandoned` means we stopped listening while the turn was still running —
   * only the deadline does that. Closing the stream does not stop the turn, so
   * without an explicit cancel the abandoned turn keeps executing and is still
   * going when the caller's next utterance arrives on this same session,
   * interleaving two turns over one call. Cancelling parks the session
   * cleanly, and whatever it had already streamed stays on the cursor.
   */
  const close = async (
    controller: TransformStreamDefaultController<Uint8Array>,
    farewell: string | null,
    abandoned = false,
  ): Promise<void> => {
    if (closed) return;
    closed = true;
    if (stallTimer !== null) clearTimeout(stallTimer);
    if (farewell !== null) controller.enqueue(encodeChunk({ text: farewell }));
    if (abandoned) {
      try {
        await session.cancel(turnId === null ? undefined : { turnId });
      } catch (error) {
        console.error(`AgentPhone voice cancel failed for ${callId}.`, error);
      }
    }
    await persistCursor();
    controller.terminate();
  };

  const chunks = events.pipeThrough(
    new TransformStream<HandleMessageStreamEvent, Uint8Array>({
      // Armed here, not in `transform`: a session that stalls emits no further
      // event, so a deadline checked only per-event can never fire and the
      // response would hang past the provider's webhook timeout.
      start(controller) {
        stallTimer = setTimeout(() => {
          void close(controller, spoke ? null : TOO_SLOW, true);
        }, TURN_BUDGET_MS);
      },

      async transform(event, controller) {
        if (closed) return;
        consumed += 1;
        const type = event.type;
        const data = ((event as { data?: unknown }).data ?? {}) as Record<string, unknown>;

        // The first turn.started after our send is ours; everything spoken is
        // scoped to it, so a stale event cannot leak into the call.
        if (turnId === null && type === "turn.started" && typeof data.turnId === "string") {
          turnId = data.turnId;
        }
        if (turnId !== null && data.turnId !== undefined && data.turnId !== turnId) return;

        if (type === "actions.requested" && !spoke) {
          spoke = true;
          controller.enqueue(encodeChunk({ text: HOLDING_LINE, interim: true }));
          return;
        }

        if (type === "message.completed") {
          const message = typeof data.message === "string" ? data.message : "";
          const text = speakable(message);
          if (text.length === 0) return;
          spoke = true;
          // Narration before a tool call keeps the turn open; the terminal
          // message is the chunk that closes it.
          const interim = data.finishReason === "tool-calls";
          controller.enqueue(encodeChunk(interim ? { text, interim: true } : { text }));
          return;
        }

        if (type === "turn.failed") {
          await close(controller, TURN_FAILED);
          return;
        }

        // A parked session holds its stream open forever, so the turn boundary
        // is what ends the HTTP response.
        if (isCurrentTurnBoundaryEvent(event)) {
          await close(controller, spoke ? null : NOTHING_HEARD);
        }
      },

      // Covers the source ending on its own; close() is idempotent.
      async flush(controller) {
        await close(controller, spoke ? null : NOTHING_HEARD);
      },
    }),
  );

  return new Response(chunks, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      // Proxies that buffer would defeat the point: TTS speaks on the first
      // chunk, so the first chunk has to leave immediately.
      "x-accel-buffering": "no",
    },
  });
}
