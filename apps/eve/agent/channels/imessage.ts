import { POST, defineChannel } from "eve/channels";

import {
  type InboundFileRef,
  type VerifiedPairing,
  activateIMessageSpace,
  claimIMessageInbound,
  discardIMessageInboundForReset,
  isIMessageInboundBatchCurrent,
  isIMessageSpaceActive,
  normalizeHandle,
  parseSpectrumDelivery,
  recordIMessageInboundBatch,
  releaseIMessageInboundBatch,
  renderInboundContent,
  releaseIMessageDeliveryLock,
  sendIMessageReply,
  sendIMessageRichlink,
  sendIMessageTyping,
  settleIMessageInbound,
  tryAcquireIMessageDeliveryLock,
  verifiedIMessagePairing,
} from "../lib/effect/imessage";
import { runTool } from "../lib/effect/runtime";
import {
  ROUTER_SIGNATURE_HEADER,
  ROUTER_TIMESTAMP_HEADER,
  signAttachmentAccess,
  verifyV0Signature,
} from "../lib/imessage-signature";
import {
  imessageContinuationToken,
  isIMessageResetCommand,
  legacyIMessageContinuationToken,
  renderIMessageInputRequests,
} from "../lib/imessage-session";

// iMessage, via the shared-number router (agent/lib/effect/imessage.ts). The
// router receives every Spectrum webhook for the shared line, looks the
// sender up in its registry, and forwards the raw delivery here — re-signed
// with this deployment's pairing secret. Mounted at POST
// /eve/v1/imessage/inbound. Replies go back out through the router's
// /api/imessage/send, which only accepts sends to this deployment's own
// paired handle or into group spaces bound to it.
//
// Personal-agent policy: DMs only from the paired handle. Group chats are
// owner opt-in per space — the space unlocks when the owner speaks in it,
// after which other participants ("guests") reach the agent too, attributed
// and marked as not-the-owner. Anything else is acknowledged and dropped.

/**
 * In group chats the agent is told to answer with exactly this token when a
 * message needs no reply from it (family chatter, messages between other
 * people). The channel swallows it instead of texting it.
 */
const NO_REPLY_TOKEN = "[no-reply]";

interface IMessageState {
  /** The paired owner's handle — the DM reply target and the send authorizer. */
  handle: string | null;
  /** Line the conversation was received on; replies pin to it so the owner
   * keeps texting one number even when auto-scale gives the project several. */
  phone: string | null;
  /** Group space id when this session lives in a group chat; null for DMs. */
  space: string | null;
  /** Whether the current turn has delivered any text. A reply clears the
   * typing bubble natively; a turn that ends silent must clear it itself. */
  replied: boolean;
  /**
   * Database claims backing this inbound turn. /new makes them terminal, so
   * late model output from the superseded turn can be dropped before send.
   * Proactive turns have no inbound claims.
   */
  inboundBatchIds?: readonly string[] | null;
  /** Provider conversation id used by the durable send/reset delivery lease. */
  conversationId?: string | null;
  /** When the last typing-start signal went out (ms epoch), to throttle
   * re-asserts during tool-heavy turns. */
  typingAt: number;
}

/** Re-assert typing at most this often while a turn keeps requesting tools. */
const TYPING_REASSERT_MS = 25_000;

/** Stay under the router's 25s forward timeout; a busy reset is retried. */
const DELIVERY_LOCK_WAIT_MS = 20_000;
const DELIVERY_LOCK_RETRY_MS = 50;

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

/** Stable ordering for reset barriers, even when Spectrum omits its timestamp. */
function deliveryOrderMs(timestamp: string | undefined, routeEntryMs: number): number {
  if (timestamp === undefined) return routeEntryMs;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : routeEntryMs;
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

async function acquireDeliveryLock(
  ownerHandle: string,
  spaceId: string,
): Promise<string | null> {
  const deadline = Date.now() + DELIVERY_LOCK_WAIT_MS;
  do {
    const token = await runTool(
      tryAcquireIMessageDeliveryLock({ ownerHandle, spaceId }),
    );
    if (token !== null) return token;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_LOCK_RETRY_MS));
  } while (true);
}

async function releaseDeliveryLock(
  ownerHandle: string,
  spaceId: string,
  token: string,
): Promise<void> {
  await runTool(releaseIMessageDeliveryLock({ ownerHandle, spaceId, token })).catch(
    (error: unknown) => {
      console.error(`iMessage delivery lock release failed for ${spaceId}.`, error);
    },
  );
}

async function deliverText(state: IMessageState, text: string): Promise<void> {
  const handle = state.handle;
  if (handle === null || handle.length === 0) {
    console.error("iMessage outbound dropped: the session has no handle.");
    return;
  }
  if (state.space !== null && text.trim() === NO_REPLY_TOKEN) return;
  const batchIds = state.inboundBatchIds;
  const conversationId = state.conversationId;
  let deliveryLockToken: string | null = null;
  if (batchIds !== null && batchIds !== undefined) {
    if (conversationId === null || conversationId === undefined) {
      console.error("iMessage outbound dropped: its inbound turn has no conversation id.");
      return;
    }
    deliveryLockToken = await acquireDeliveryLock(handle, conversationId).catch(
      (error: unknown) => {
        console.error(`iMessage delivery lock acquisition failed for ${conversationId}.`, error);
        return null;
      },
    );
    if (deliveryLockToken === null) {
      console.error(`iMessage outbound dropped: conversation ${conversationId} stayed busy.`);
      return;
    }
  }
  try {
    if (batchIds !== null && batchIds !== undefined) {
      const active = await runTool(
        isIMessageInboundBatchCurrent(batchIds),
      ).catch((error: unknown) => {
        console.error("iMessage outbound dispatch-barrier check failed.", error);
        return false;
      });
      if (!active) {
        console.warn("iMessage outbound dropped: its inbound turn was superseded by /new.");
        return;
      }
    }
    const phone = state.phone ?? undefined;
    const space = state.space ?? undefined;
    // A reply that is exactly one link goes out as a native rich-link
    // preview card; anything else is a plain text. Rich links are
    // handle-scoped (DM) on the router, so group replies stay plain text.
    if (space === undefined && isSingleUrl(text)) {
      await runTool(sendIMessageRichlink({ handle, url: text.trim(), phone })).catch(() =>
        runTool(sendIMessageReply({ handle, text, phone })),
      );
    } else {
      await runTool(sendIMessageReply({ handle, text, phone, space }));
    }
    state.replied = true;
  } catch (error) {
    console.error(`iMessage outbound to ${state.space ?? handle} failed.`, error);
  } finally {
    if (
      deliveryLockToken !== null &&
      conversationId !== null &&
      conversationId !== undefined
    ) {
      await releaseDeliveryLock(handle, conversationId, deliveryLockToken);
    }
  }
}

/**
 * Typing indicator while Ruth works on a reply. Purely cosmetic, so any
 * failure — including a router deployed before the /api/imessage/typing
 * endpoint existed — is logged and swallowed, never surfaced to the turn.
 * Typing is handle-scoped (DM) on the router, so group sessions skip it.
 */
async function signalTyping(state: IMessageState, typing: "start" | "stop"): Promise<void> {
  const handle = state.handle;
  if (handle === null || handle.length === 0) return;
  if (state.space !== null) return;
  try {
    await runTool(sendIMessageTyping({ handle, state: typing, phone: state.phone ?? undefined }));
  } catch (error) {
    console.warn(`iMessage typing ${typing} for ${handle} failed.`, error);
  }
}

export default defineChannel<
  IMessageState,
  { state: IMessageState },
  { handle?: string; phone?: string; space?: string },
  { handle: string | null; phone: string | null; space: string | null }
>({
  state: {
    handle: null,
    phone: null,
    space: null,
    replied: false,
    inboundBatchIds: null,
    conversationId: null,
    typingAt: 0,
  },

  context(state) {
    return { state };
  },

  // Read by the iMessage dynamic tool resolvers (via isChannel): the paired
  // handle and line for outbound sends. Per-turn values (like the tapback
  // target message id) ride the turn's auth attributes instead — the state
  // projection can lag one turn behind at resolve time.
  metadata(state) {
    return { handle: state.handle, phone: state.phone, space: state.space };
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
    POST("/eve/v1/imessage/inbound", async (req, { reset, send }) => {
      // Capture before any I/O. If this webhook stalls before its database
      // claim while a later /new completes, the reset cutoff still knows this
      // delivery began first.
      const routeEntryMs = Date.now();
      const routeReceivedAtMs = performance.timeOrigin + performance.now();
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
      const receivedAtMs = deliveryOrderMs(delivery.message.timestamp, routeEntryMs);

      // Who may speak: in a DM, only the paired handle. In a group, the
      // paired handle always — and their first message opts the space in for
      // everyone else. The router already routes this way, but admission
      // must not depend on someone else's code, so it is re-checked here
      // against this deployment's own records.
      const isGroup = (delivery.space.type ?? "dm") === "group";
      const sender = delivery.message.sender?.id ?? "";
      const handle = normalizeHandle(sender) ?? sender;
      if (handle.length === 0) {
        console.error("iMessage inbound dropped: the message has no sender.");
        return Response.json({ ok: true, ignored: "sender" });
      }
      const isOwner = handle === pairing.handle;
      if (!isGroup && !isOwner) {
        console.error(`iMessage inbound dropped: sender ${sender} is not the paired handle.`);
        return Response.json({ ok: true, ignored: "sender" });
      }
      if (isGroup && isOwner) {
        await runTool(
          activateIMessageSpace({ spaceId: delivery.space.id, handle: pairing.handle }),
        );
      }
      if (isGroup && !isOwner) {
        const active = await runTool(
          isIMessageSpaceActive({ spaceId: delivery.space.id, handle: pairing.handle }),
        );
        if (!active) {
          // The router only forwards guest messages for spaces it believes
          // are bound here, so a miss is transient state skew — the owner's
          // activating message still in flight, or an activation lost to
          // unpair/re-pair. Refusing with a 5xx-able status makes the router
          // fail the webhook and Spectrum retry, instead of the message
          // being acknowledged and silently lost.
          console.error(
            `iMessage inbound refused: group ${delivery.space.id} is not owner-activated yet.`,
          );
          return new Response("Group space not activated on this deployment", { status: 409 });
        }
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
          ownerHandle: pairing.handle,
          handle,
          text: content.text,
          receivedAtMs,
          routeReceivedAtMs,
        }),
      );
      if (claim === "done") return Response.json({ ok: true, ignored: "duplicate" });

      const sessionSpace = isGroup ? delivery.space.id : null;
      const continuationToken = imessageContinuationToken(pairing, sessionSpace);

      // A signed, owner-authored /new is the text-surface escape hatch for a
      // session parked on approval, authorization, or a bad historical turn.
      // Reset the legacy token too so deployments upgraded from the old
      // handle-only scheme do not leave an unreachable workflow running.
      if (isOwner && isIMessageResetCommand(content.text, content.files.length > 0)) {
        const legacyToken = legacyIMessageContinuationToken(pairing.handle, sessionSpace);
        const deliveryLockToken = await acquireDeliveryLock(
          pairing.handle,
          delivery.space.id,
        ).catch((error: unknown) => {
          console.error(`iMessage /new delivery lock failed for ${delivery.space.id}.`, error);
          return null;
        });
        if (deliveryLockToken === null) {
          return new Response("iMessage conversation is busy; retry /new", { status: 503 });
        }
        try {
          // The durable lease spans discard through confirmation. An old
          // reply that won it first completes before this confirmation; one
          // that acquires it afterward re-checks the now-reset batch and drops.
          await runTool(
            discardIMessageInboundForReset({
              ownerHandle: pairing.handle,
              spaceId: delivery.space.id,
              resetMessageId: delivery.message.id,
              resetAtMs: receivedAtMs,
              resetRouteReceivedAtMs: routeReceivedAtMs,
            }),
          );
          await reset({
            continuationToken,
            reason: "iMessage owner requested /new",
          });
          if (legacyToken !== continuationToken) {
            await reset({
              continuationToken: legacyToken,
              reason: "iMessage owner requested /new",
            });
          }
          await runTool(
            sendIMessageReply({
              handle: pairing.handle,
              text: "Started a fresh conversation.",
              phone: delivery.space.phone,
              ...(sessionSpace !== null ? { space: sessionSpace } : {}),
            }),
          );
          await runTool(
            recordIMessageInboundBatch([delivery.message.id], { status: "ok" }),
          ).catch((error: unknown) => {
            console.error(`iMessage /new ${delivery.message.id} bookkeeping failed.`, error);
          });
          return Response.json({ ok: true, reset: true });
        } catch (error) {
          console.error("iMessage /new failed.", error);
          return new Response("Reset failed", { status: 500 });
        } finally {
          await releaseDeliveryLock(
            pairing.handle,
            delivery.space.id,
            deliveryLockToken,
          );
        }
      }

      // Pure text waits out the burst window so rapid follow-ups fold into
      // one turn; messages with files dispatch immediately (their follow-ups
      // drain into the next text's batch).
      if (content.files.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, TEXT_DEBOUNCE_MS));
      }
      const settled = await runTool(
        settleIMessageInbound({
          handle,
          spaceId: delivery.space.id,
          messageId: delivery.message.id,
        }),
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

      const context = [
        isGroup
          ? isOwner
            ? `This message arrived over iMessage in a group chat (space ${delivery.space.id}) from ${handle} — the owner. Everyone in the group sees your replies.`
            : `This message arrived over iMessage in a group chat (space ${delivery.space.id}) from ${handle} — a group participant, NOT your owner. Everyone in the group sees your replies.`
          : `This message arrived over iMessage from ${handle} — the owner texting the shared line. Space ${delivery.space.id}.`,
        ...(settled.batch.length > 1
          ? [
              `${handle} sent ${settled.batch.length} messages in quick succession; they are combined above — answer them as one.`,
            ]
          : []),
      ];

      try {
        await send(
          {
            message,
            context,
          },
          {
            auth: {
              authenticator: "imessage-router",
              principalType: "user",
              principalId: `imessage:${handle}`,
              attributes: {
                handle,
                space_id: delivery.space.id,
                chat: isGroup ? "group" : "dm",
                role: isOwner ? "owner" : "guest",
                // The turn's tapback target: per-turn auth is fresh at
                // dynamic-tool resolve time, unlike the state projection.
                message_id: delivery.message.id,
                ...(delivery.space.phone !== undefined ? { line_phone: delivery.space.phone } : {}),
              },
            },
            // The pairing generation isolates a newly paired owner from old
            // sessions parked on approval or authorization under this handle.
            continuationToken,
            state: {
              handle: pairing.handle,
              phone: delivery.space.phone ?? null,
              space: isGroup ? delivery.space.id : null,
              replied: false,
              inboundBatchIds: batchIds,
              conversationId: delivery.space.id,
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
  // receive(imessage, { message, target: { handle, space? }, auth }).
  // `handle` is always the paired owner's; `space` posts into a group the
  // owner has already activated instead of DMing them.
  async receive(input, { send }) {
    const raw = typeof input.target.handle === "string" ? input.target.handle : "";
    const handle = normalizeHandle(raw);
    if (handle === null) {
      throw new Error("imessage receive requires target.handle (+E.164 phone or iMessage email).");
    }
    const phone = typeof input.target.phone === "string" ? input.target.phone : null;
    const space =
      typeof input.target.space === "string" && input.target.space.trim().length > 0
        ? input.target.space.trim()
        : null;
    const pairing = await runTool(verifiedIMessagePairing());
    if (pairing === null || pairing.handle !== handle) {
      throw new Error("imessage receive target is not the currently paired owner.");
    }
    return send(input.message, {
      auth: input.auth,
      continuationToken: imessageContinuationToken(pairing, space),
      state: {
        handle,
        phone,
        space,
        replied: false,
        inboundBatchIds: null,
        conversationId: null,
        typingAt: 0,
      },
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
    async "input.requested"(event, channel) {
      await deliverText(channel.state, renderIMessageInputRequests(event.requests));
    },
    async "turn.failed"(_event, channel) {
      await deliverText(
        channel.state,
        "I hit an error while handling that. Please try again, or rephrase.",
      );
    },
  },
});
