import { POST, defineChannel } from "eve/channels";

import {
  type InboundFileRef,
  type VerifiedPairing,
  claimIMessageInbound,
  normalizeHandle,
  parseSpectrumDelivery,
  recordIMessageInboundBatch,
  releaseIMessageInboundBatch,
  renderInboundContent,
  sendIMessageReply,
  sendIMessageRichlink,
  sendIMessageTyping,
  settleIMessageInbound,
  verifiedIMessagePairing,
} from "../lib/effect/imessage";
import { runTool } from "../lib/effect/runtime";
import {
  ROUTER_SIGNATURE_HEADER,
  ROUTER_TIMESTAMP_HEADER,
  signAttachmentAccess,
  verifyV0Signature,
} from "../lib/imessage-signature";

// iMessage, via the shared-number router (agent/lib/effect/imessage.ts). The
// router receives every Spectrum webhook for the shared line, looks the
// sender up in its registry, and forwards the raw delivery here — re-signed
// with this deployment's pairing secret. Mounted at POST
// /eve/v1/imessage/inbound. Replies go back out through the router's
// /api/imessage/send, which only accepts sends to this deployment's own
// paired handle.
//
// Personal-agent policy, same as Telegram: DMs only, and only from the paired
// handle. Anything else is acknowledged and dropped.

interface IMessageState {
  handle: string | null;
  /** Line the conversation was received on; replies pin to it so the owner
   * keeps texting one number even when auto-scale gives the project several. */
  phone: string | null;
  /** Whether the current turn has delivered any text. A reply clears the
   * typing bubble natively; a turn that ends silent must clear it itself. */
  replied: boolean;
  /** When the last typing-start signal went out (ms epoch), to throttle
   * re-asserts during tool-heavy turns. */
  typingAt: number;
}

/** Re-assert typing at most this often while a turn keeps requesting tools. */
const TYPING_REASSERT_MS = 25_000;

/**
 * How long a pure-text message waits for follow-ups before dispatching.
 * People text in bursts ("hey" → "wait" → "actually nvm"); the window folds
 * a burst into one turn — and one reply — instead of three racing ones.
 * Messages carrying files skip the wait and dispatch immediately.
 */
const TEXT_DEBOUNCE_MS = 3_000;

/** How long a minted attachment URL stays fetchable; model calls take seconds. */
const ATTACHMENT_URL_TTL_MS = 15 * 60_000;

/**
 * A capability URL for one inbound attachment, served by the router and
 * signed with this deployment's pairing secret. It rides into the turn as a
 * URL file part — no bytes pass through eve, so no sandbox staging — and the
 * model call (or provider) fetches it directly.
 */
function signedAttachmentUrl(pairing: VerifiedPairing, file: InboundFileRef, phone: string | null): URL {
  const mime = file.mimeType.toLowerCase();
  const access = {
    handle: pairing.handle,
    id: file.id,
    phone: phone ?? "",
    convert: mime === "image/heic" || mime === "image/heif",
    expires: Math.floor((Date.now() + ATTACHMENT_URL_TTL_MS) / 1000),
  };
  const url = new URL(`${pairing.routerUrl}/api/imessage/attachment`);
  url.searchParams.set("handle", access.handle);
  url.searchParams.set("id", access.id);
  if (access.phone.length > 0) url.searchParams.set("phone", access.phone);
  if (access.convert) url.searchParams.set("convert", "jpeg");
  url.searchParams.set("expires", String(access.expires));
  url.searchParams.set("sig", signAttachmentAccess(pairing.secret, access));
  return url;
}

/** The media type the model will receive (HEIC converts to JPEG in transit). */
function forwardedMediaType(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  return mime === "image/heic" || mime === "image/heif" ? "image/jpeg" : mimeType;
}

/** True when the reply is nothing but one bare URL. */
function isSingleUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!/^https:\/\/\S+$/.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

async function deliverText(state: IMessageState, text: string): Promise<void> {
  const handle = state.handle;
  if (handle === null || handle.length === 0) {
    console.error("iMessage outbound dropped: the session has no handle.");
    return;
  }
  const phone = state.phone ?? undefined;
  try {
    // A reply that is exactly one link goes out as a native rich-link
    // preview card; anything else is a plain text.
    if (isSingleUrl(text)) {
      await runTool(sendIMessageRichlink({ handle, url: text.trim(), phone })).catch(() =>
        runTool(sendIMessageReply({ handle, text, phone })),
      );
    } else {
      await runTool(sendIMessageReply({ handle, text, phone }));
    }
    state.replied = true;
  } catch (error) {
    console.error(`iMessage outbound to ${handle} failed.`, error);
  }
}

/**
 * Typing indicator while Ruth works on a reply. Purely cosmetic, so any
 * failure — including a router deployed before the /api/imessage/typing
 * endpoint existed — is logged and swallowed, never surfaced to the turn.
 */
async function signalTyping(state: IMessageState, typing: "start" | "stop"): Promise<void> {
  const handle = state.handle;
  if (handle === null || handle.length === 0) return;
  try {
    await runTool(sendIMessageTyping({ handle, state: typing, phone: state.phone ?? undefined }));
  } catch (error) {
    console.warn(`iMessage typing ${typing} for ${handle} failed.`, error);
  }
}

export default defineChannel<
  IMessageState,
  { state: IMessageState },
  { handle?: string; phone?: string },
  { handle: string | null; phone: string | null }
>({
  state: { handle: null, phone: null, replied: false, typingAt: 0 },

  context(state) {
    return { state };
  },

  // Read by the iMessage dynamic tool resolvers (via isChannel): the paired
  // handle and line for outbound sends. Per-turn values (like the tapback
  // target message id) ride the turn's auth attributes instead — the state
  // projection can lag one turn behind at resolve time.
  metadata(state) {
    return { handle: state.handle, phone: state.phone };
  },

  // Inbound-attachment file parts point at the router's signed attachment
  // endpoint (see signedAttachmentUrl). Fetch the bytes so eve stages them
  // and inlines images/PDFs into the model call — providers reject URL
  // sources, so the bytes must ride in the message itself.
  async fetchFile(url) {
    if (!url.includes("/api/imessage/attachment?")) return null;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`iMessage attachment fetch failed with HTTP ${response.status}`);
    }
    const rawName = response.headers.get("x-attachment-name");
    let filename: string | undefined;
    if (rawName !== null) {
      try {
        filename = decodeURIComponent(rawName);
      } catch {
        filename = rawName;
      }
    }
    const mediaType = response.headers.get("content-type");
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      ...(mediaType !== null ? { mediaType } : {}),
      ...(filename !== undefined ? { filename } : {}),
    };
  },

  routes: [
    POST("/eve/v1/imessage/inbound", async (req, { send }) => {
      const pairing = await runTool(verifiedIMessagePairing()).catch(() => null);
      if (pairing === null) {
        return new Response("iMessage is not paired on this deployment", { status: 503 });
      }

      // Signature verification needs the exact bytes; parse only after it holds.
      const body = await req.text();
      const verification = verifyV0Signature({
        secret: pairing.secret,
        timestamp: req.headers.get(ROUTER_TIMESTAMP_HEADER),
        signature: req.headers.get(ROUTER_SIGNATURE_HEADER),
        rawBody: body,
      });
      if (!verification.ok) {
        console.error(`iMessage inbound rejected: ${verification.reason}.`);
        return new Response("Invalid signature", { status: 401 });
      }

      const delivery = parseSpectrumDelivery(body);
      if (delivery === null) return new Response("Invalid payload", { status: 400 });
      if (delivery.event !== "messages") {
        return Response.json({ ok: true, ignored: delivery.event });
      }

      // DMs from the paired handle only. The router already routes by sender,
      // but the sender check must not depend on someone else's code.
      if ((delivery.space.type ?? "dm") !== "dm") {
        return Response.json({ ok: true, ignored: "group" });
      }
      const sender = delivery.message.sender?.id ?? "";
      const handle = normalizeHandle(sender) ?? sender;
      if (handle.length === 0 || handle !== pairing.handle) {
        console.error(`iMessage inbound dropped: sender ${sender || "(none)"} is not the paired handle.`);
        return Response.json({ ok: true, ignored: "sender" });
      }

      const content = renderInboundContent(delivery.message.content);
      if (content.text === null && content.files.length === 0) {
        return Response.json({ ok: true, ignored: "content" });
      }

      // Synchronous on purpose: a failure here must surface as a 5xx so the
      // router (and Spectrum behind it) retries instead of losing the text.
      const claim = await runTool(
        claimIMessageInbound({
          messageId: delivery.message.id,
          spaceId: delivery.space.id,
          handle,
          text: content.text,
        }),
      );
      if (claim === "done") return Response.json({ ok: true, ignored: "duplicate" });

      // Pure text waits out the burst window so rapid follow-ups fold into
      // one turn; messages with files dispatch immediately (their follow-ups
      // drain into the next text's batch).
      if (content.files.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, TEXT_DEBOUNCE_MS));
      }
      const settled = await runTool(
        settleIMessageInbound({ handle, messageId: delivery.message.id }),
      );
      if (!settled.dispatch) {
        // A newer message owns the batch now; it delivers this text too.
        return Response.json({ ok: true, batched: true });
      }

      const texts = settled.batch
        .map((entry) => entry.text)
        .filter((text): text is string => text !== null && text.trim().length > 0);
      const message = [
        ...(texts.length > 0 ? [{ type: "text" as const, text: texts.join("\n") }] : []),
        ...content.files.map((file) => ({
          type: "file" as const,
          data: signedAttachmentUrl(pairing, file, delivery.space.phone ?? null),
          mediaType: forwardedMediaType(file.mimeType),
        })),
      ];
      const batchIds = settled.batch.map((entry) => entry.messageId);

      try {
        await send(
          {
            message,
            context: [
              `This message arrived over iMessage from ${handle} — the owner texting the shared line. Space ${delivery.space.id}.`,
              ...(settled.batch.length > 1
                ? [
                    `He sent ${settled.batch.length} messages in quick succession; they are combined above — answer them as one.`,
                  ]
                : []),
            ],
          },
          {
            auth: {
              authenticator: "imessage-router",
              principalType: "user",
              principalId: `imessage:${handle}`,
              attributes: {
                handle,
                space_id: delivery.space.id,
                // The turn's tapback target: per-turn auth is fresh at
                // dynamic-tool resolve time, unlike the state projection.
                message_id: delivery.message.id,
                ...(delivery.space.phone !== undefined ? { line_phone: delivery.space.phone } : {}),
              },
            },
            continuationToken: handle,
            state: {
              handle,
              phone: delivery.space.phone ?? null,
              replied: false,
              typingAt: 0,
            },
          },
        );
      } catch (error) {
        // The batch's other texts go back to the queue; dropping this
        // message's own claim lets the router's retry reprocess it.
        await runTool(
          releaseIMessageInboundBatch({
            ownMessageId: delivery.message.id,
            batchMessageIds: batchIds,
          }),
        ).catch(() => undefined);
        console.error(`iMessage inbound ${delivery.message.id} failed.`, error);
        return new Response("Delivery failed", { status: 500 });
      }

      // The turn is dispatched; a bookkeeping miss must not trigger a retry
      // (the claims stand, so a retry would be dropped as a duplicate anyway).
      await runTool(recordIMessageInboundBatch(batchIds, { status: "ok" })).catch(
        (error: unknown) => {
          console.error(`iMessage inbound ${delivery.message.id} bookkeeping failed.`, error);
        },
      );
      return Response.json({ ok: true });
    }),
  ],

  // Proactive path for schedules and cross-channel hand-offs:
  // receive(imessage, { message, target: { handle }, auth }).
  async receive(input, { send }) {
    const raw = typeof input.target.handle === "string" ? input.target.handle : "";
    const handle = normalizeHandle(raw);
    if (handle === null) {
      throw new Error("imessage receive requires target.handle (+E.164 phone or iMessage email).");
    }
    const phone = typeof input.target.phone === "string" ? input.target.phone : null;
    return send(input.message, {
      auth: input.auth,
      continuationToken: handle,
      state: { handle, phone, replied: false, typingAt: 0 },
    });
  },

  events: {
    // Typing shows the moment Ruth starts working (same convention as eve's
    // Slack/Discord/Teams channels) and is re-asserted while tools run so the
    // bubble survives long turns. The reply itself clears it on the owner's
    // device; only a turn that ends without delivering any text stops it by
    // hand.
    async "turn.started"(_event, channel) {
      channel.state.replied = false;
      channel.state.typingAt = Date.now();
      await signalTyping(channel.state, "start");
    },
    async "actions.requested"(_event, channel) {
      if (Date.now() - channel.state.typingAt < TYPING_REASSERT_MS) return;
      channel.state.typingAt = Date.now();
      await signalTyping(channel.state, "start");
    },
    async "turn.completed"(_event, channel) {
      if (!channel.state.replied) await signalTyping(channel.state, "stop");
    },
    async "turn.cancelled"(_event, channel) {
      if (!channel.state.replied) await signalTyping(channel.state, "stop");
    },
    async "message.completed"(event, channel) {
      if (event.finishReason === "tool-calls" || !event.message) return;
      await deliverText(channel.state, event.message);
    },
    async "input.requested"(_event, channel) {
      // No buttons on iMessage yet; parked approvals continue in the web chat.
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
