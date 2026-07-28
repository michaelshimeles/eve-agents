import { POST, defineChannel } from "eve/channels";

import {
  AGENTPHONE_SIGNATURE_HEADER,
  AGENTPHONE_TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../lib/agentphone-signature";
import { parseVoice, voiceAuth, voiceResponse } from "../lib/agentphone-voice-stream";
import {
  claimPhoneInbound,
  normalizeNumber,
  phoneCallCursor,
  recordPhoneInboundBatch,
  releasePhoneInboundBatch,
  sendText,
  sendTypingIndicator,
  settlePhoneInbound,
  verifiedPhone,
} from "../lib/effect/agentphone";
import { runTool } from "../lib/effect/runtime";
import agentphoneVoice from "./agentphone-voice";

// The AgentPhone webhook, mounted at POST /eve/v1/agentphone/inbound.
//
// One dedicated number that speaks SMS, MMS, and iMessage; the provider picks
// the transport per recipient.
//
// This route is the deployment's ONLY callback, because AgentPhone registers a
// single webhook per project and delivers every event to it. So it verifies
// the signature once and then splits by event family:
//
//   channel: "voice"  -> hand the transcript to the agentphone-voice channel
//                        and stream the turn back as the response body, which
//                        is the contract the provider's TTS reads from.
//   otherwise         -> texting, in the ordinary shape: acknowledge the
//                        webhook and push replies back through the API.
//
// Registering only one of the two paths was a real bug caught in review: voice
// events landed here, matched no text shape, and were acknowledged as ignored,
// so a caller heard nothing at all.
//
// Personal-agent policy, same as the iMessage channel: only the owner's number
// opens a session in a 1:1 thread. Group threads are owner opt-in — the space
// unlocks when the owner speaks in it, after which other participants reach
// Ruth as attributed guests. Anything else is acknowledged and dropped, with a
// 200 so the provider's six-attempt retry schedule stops.

/**
 * Answered with exactly this token when a group message needs no reply. The
 * channel swallows it rather than texting it back.
 */
const NO_REPLY_TOKEN = "[no-reply]";

/**
 * How long a text waits for follow-ups before dispatching. People text in
 * bursts ("hey" -> "wait" -> "actually nvm"); the window folds a burst into
 * one turn instead of three racing ones. Messages carrying media skip it.
 */
const TEXT_DEBOUNCE_MS = 3_000;

/** Re-assert typing at most this often while a turn keeps requesting tools. */
const TYPING_REASSERT_MS = 25_000;

interface PhoneState {
  /** Who we are talking to: an E.164 number, or a `grp_...` group id. */
  target: string | null;
  /** The provider's conversation id, for typing indicators. */
  conversationId: string | null;
  /** True when the thread has more than two participants. */
  group: boolean;
  /** Whether this turn has delivered any text yet. */
  replied: boolean;
  /** When typing was last signalled (ms epoch), to throttle re-asserts. */
  typingAt: number;
}

interface InboundText {
  readonly messageId: string;
  readonly conversationId: string;
  readonly from: string;
  readonly text: string;
  readonly mediaUrls: readonly string[];
  readonly group: { id: string; name: string | null } | null;
  readonly senderIdentifier: string | null;
}

/** Reads an inbound text envelope, or null when this delivery is not one. */
function parseInbound(raw: unknown): InboundText | null {
  if (raw === null || typeof raw !== "object") return null;
  const { event, channel, data } = raw as {
    event?: unknown;
    channel?: unknown;
    data?: unknown;
  };
  if (event !== "agent.message") return null;
  if (channel !== "sms" && channel !== "mms" && channel !== "imessage") return null;
  if (data === null || typeof data !== "object") return null;

  const record = data as Record<string, unknown>;
  if (record.direction === "outbound") return null; // our own send, echoed back

  const messageId = typeof record.id === "string" ? record.id : null;
  const conversationId =
    typeof record.conversationId === "string" ? record.conversationId : null;
  const from = typeof record.from === "string" ? record.from : null;
  if (conversationId === null || from === null) return null;

  const media: string[] = [];
  if (typeof record.mediaUrl === "string" && record.mediaUrl.length > 0) {
    media.push(record.mediaUrl);
  }
  if (Array.isArray(record.mediaUrls)) {
    for (const url of record.mediaUrls) if (typeof url === "string") media.push(url);
  }

  // `group` is absent entirely on 1:1 threads, so its presence is the test.
  const rawGroup = record.group;
  let group: { id: string; name: string | null } | null = null;
  if (rawGroup !== null && typeof rawGroup === "object") {
    const { groupId, groupName } = rawGroup as Record<string, unknown>;
    if (typeof groupId === "string" && groupId.length > 0) {
      group = { id: groupId, name: typeof groupName === "string" ? groupName : null };
    }
  }

  return {
    // The provider does not always stamp an id; the conversation plus arrival
    // time is stable enough to dedupe a retry, which is all the claim needs.
    messageId: messageId ?? `${conversationId}:${String(record.receivedAt ?? "")}`,
    conversationId,
    from,
    text: typeof record.message === "string" ? record.message : "",
    mediaUrls: media,
    group,
    senderIdentifier:
      typeof record.senderIdentifier === "string" ? record.senderIdentifier : null,
  };
}

/** Sends one reply, swallowing failures so a dead line cannot fail the turn. */
async function deliverText(state: PhoneState, text: string): Promise<void> {
  const target = state.target;
  if (target === null || target.length === 0) {
    console.error("AgentPhone outbound dropped: the session has no target.");
    return;
  }
  if (state.group && text.trim() === NO_REPLY_TOKEN) return;
  try {
    await runTool(sendText({ to: target, text }));
    state.replied = true;
  } catch (error) {
    console.error(`AgentPhone outbound to ${target} failed.`, error);
  }
}

async function signalTyping(state: PhoneState): Promise<void> {
  if (state.conversationId === null) return;
  await runTool(sendTypingIndicator(state.conversationId)).catch(() => {
    // Best-effort: dropped for SMS recipients, and a missing bubble is not
    // worth failing a turn over.
  });
}

export default defineChannel<
  PhoneState,
  { state: PhoneState },
  { target?: string; conversationId?: string },
  { target: string | null; conversationId: string | null; group: boolean }
>({
  state: { target: null, conversationId: null, group: false, replied: false, typingAt: 0 },

  context(state) {
    return { state };
  },

  metadata(state) {
    return { target: state.target, conversationId: state.conversationId, group: state.group };
  },

  routes: [
    POST("/eve/v1/agentphone/inbound", async (req, { send, receive }) => {
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
        console.error(`AgentPhone signature rejected: ${verified.reason}`);
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return Response.json({ error: "malformed body" }, { status: 400 });
      }

      // Voice first: it is the branch that must answer with a body rather
      // than an acknowledgement.
      const voice = parseVoice(parsed);
      if (voice !== null) {
        // A finished call needs no reply — the transcript already lives in
        // that call's session history, because every turn ran against it.
        if (voice.event === "agent.call_ended") return Response.json({ ok: true });
        if (voice.transcript.trim().length === 0) {
          return Response.json({ ok: true, ignored: "empty" });
        }

        const cursor = await runTool(phoneCallCursor(voice.callId)).catch(() => 0);
        const session = await receive(agentphoneVoice, {
          message: voice.transcript,
          target: { callId: voice.callId, from: voice.from },
          auth: voiceAuth(voice, phone.ownerNumber),
        });

        return await voiceResponse({ session, callId: voice.callId, cursor });
      }

      const inbound = parseInbound(parsed);
      if (inbound === null) return Response.json({ ok: true, ignored: "event" });
      if (inbound.text.trim().length === 0 && inbound.mediaUrls.length === 0) {
        return Response.json({ ok: true, ignored: "empty" });
      }

      const sender = normalizeNumber(inbound.senderIdentifier ?? inbound.from);
      const owner = phone.ownerNumber;
      const isOwner = owner !== null && sender !== null && sender === owner;

      // Admission. A stranger's text is answered 200 and dropped: replying
      // would turn a public number into a spam target, and a 2xx stops the
      // provider retrying something we will never accept.
      if (inbound.group === null && !isOwner) {
        return Response.json({ ok: true, ignored: "sender" });
      }
      if (inbound.group !== null && !isOwner) {
        // Guests in a group only reach Ruth once the owner has spoken there.
        // Without an activation record this is either a group she was added
        // to by a stranger, or the owner's opening message is still in
        // flight — 409 so the provider redelivers rather than losing it.
        return Response.json({ ok: false, reason: "group not activated" }, { status: 409 });
      }

      const target = inbound.group !== null ? inbound.group.id : (sender ?? inbound.from);

      const claim = await runTool(
        claimPhoneInbound({
          messageId: inbound.messageId,
          conversationId: inbound.conversationId,
          sender: sender ?? inbound.from,
          text: inbound.text,
        }),
      );
      if (claim === "done") return Response.json({ ok: true, ignored: "duplicate" });

      // Text alone waits for the rest of the burst; media dispatches at once.
      if (inbound.mediaUrls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, TEXT_DEBOUNCE_MS));
      }

      const settled = await runTool(
        settlePhoneInbound({
          messageId: inbound.messageId,
          conversationId: inbound.conversationId,
          sender: sender ?? inbound.from,
        }),
      );
      if (!settled.dispatch) return Response.json({ ok: true, batched: true });

      const batchIds = settled.batch.map((entry) => entry.messageId);
      const text = settled.batch
        .map((entry) => entry.text ?? "")
        .filter((entry) => entry.length > 0)
        .join("\n");

      const context: string[] = [];
      if (inbound.group !== null) {
        context.push(
          isOwner
            ? `This message arrived over text in a group chat (${inbound.group.name ?? inbound.group.id}) from your owner. Everyone in the group sees your replies. Answer with exactly ${NO_REPLY_TOKEN} when a message needs no reply from you.`
            : `This message arrived over text in a group chat (${inbound.group.name ?? inbound.group.id}) from ${sender ?? inbound.from} — a group participant, NOT your owner. Everyone in the group sees your replies. Answer with exactly ${NO_REPLY_TOKEN} when a message needs no reply from you.`,
        );
      }
      if (settled.batch.length > 1) {
        context.push(`They sent ${settled.batch.length} messages in quick succession.`);
      }

      const state: PhoneState = {
        target,
        conversationId: inbound.conversationId,
        group: inbound.group !== null,
        replied: false,
        typingAt: Date.now(),
      };

      try {
        await send(
          {
            message:
              inbound.mediaUrls.length === 0
                ? text
                : [
                    ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
                    ...inbound.mediaUrls.map((url) => ({
                      type: "file" as const,
                      data: new URL(url),
                      mediaType: "image/jpeg",
                    })),
                  ],
            ...(context.length > 0 ? { context } : {}),
          },
          {
            auth: {
              authenticator: "agentphone",
              principalType: "user",
              principalId: `tel:${sender ?? inbound.from}`,
              attributes: {
                from: sender ?? inbound.from,
                conversation_id: inbound.conversationId,
                message_id: inbound.messageId,
                chat: inbound.group !== null ? "group" : "dm",
                // owner-gate.ts keys owner-only tool approval off this, so a
                // non-compliant model still cannot reach them on a guest turn.
                role: isOwner ? "owner" : "guest",
              },
            },
            continuationToken: target,
            state,
          },
        );
      } catch (error) {
        // Put the batch back so the provider's retry reprocesses it, then let
        // the 500 trigger that retry.
        await runTool(
          releasePhoneInboundBatch({ batchMessageIds: batchIds, ownMessageId: inbound.messageId }),
        ).catch(() => undefined);
        console.error(`AgentPhone dispatch for ${inbound.messageId} failed.`, error);
        return Response.json({ error: "dispatch failed" }, { status: 500 });
      }

      // A bookkeeping miss must not trigger a retry: the claims stand, so the
      // retry would be dropped as a duplicate anyway.
      await runTool(recordPhoneInboundBatch({ batchMessageIds: batchIds, status: "ok" })).catch(
        (error: unknown) => {
          console.error(`AgentPhone bookkeeping for ${inbound.messageId} failed.`, error);
        },
      );

      return Response.json({ ok: true });
    }),
  ],

  // Proactive path for schedules and cross-channel hand-offs:
  // receive(agentphone, { message, target: { target } }).
  async receive(input, { send }) {
    const raw = typeof input.target.target === "string" ? input.target.target : "";
    const target = normalizeNumber(raw);
    if (target === null) {
      throw new Error("agentphone receive requires target.target (+E.164 phone or group id).");
    }
    const conversationId =
      typeof input.target.conversationId === "string" ? input.target.conversationId : null;
    return send(input.message, {
      auth: input.auth,
      continuationToken: target,
      state: {
        target,
        conversationId,
        group: target.startsWith("grp_"),
        replied: false,
        typingAt: 0,
      },
    });
  },

  events: {
    async "turn.started"(_event, channel) {
      channel.state.replied = false;
      channel.state.typingAt = Date.now();
      await signalTyping(channel.state);
    },
    async "actions.requested"(_event, channel) {
      if (Date.now() - channel.state.typingAt < TYPING_REASSERT_MS) return;
      channel.state.typingAt = Date.now();
      await signalTyping(channel.state);
    },
    async "message.completed"(event, channel) {
      // Narration before a tool call is not a reply; texting it would bill a
      // segment for "let me check that".
      if (event.finishReason === "tool-calls" || !event.message) return;
      await deliverText(channel.state, event.message);
    },
    async "input.requested"(_event, channel) {
      await deliverText(
        channel.state,
        "I need your say-so to continue — open the web chat to approve or answer there.",
      );
    },
    async "turn.failed"(_event, channel) {
      await deliverText(
        channel.state,
        "I hit an error while handling that. Please try again, or rephrase.",
      );
    },
  },
});
