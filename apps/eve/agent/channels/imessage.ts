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
  reconcileIMessageInbound,
  releaseIMessageInboundBatch,
  renderInboundContent,
  releaseIMessageDeliveryLock,
  sendIMessageReply,
  sendIMessageCommand,
  sendIMessageRichlink,
  sendIMessageTyping,
  settleIMessageInbound,
  tryAcquireIMessageDeliveryLock,
  verifiedIMessagePairing,
} from "../lib/effect/imessage";
import { runTool } from "../lib/effect/runtime";
import {
  clearSafeGroupMemory,
  generateSafeGroupReply,
} from "../lib/effect/imessage/group-runtime";
import {
  extractIMessageVideo,
  inspectIMessageArchive,
} from "../lib/effect/imessage/media-sandbox";
import { transcribeIMessageAudio } from "../lib/effect/imessage/media";
import {
  ROUTER_SIGNATURE_HEADER,
  ROUTER_TIMESTAMP_HEADER,
  signOpaqueAttachmentAccess,
  verifyV0Signature,
} from "../lib/imessage-signature";
import {
  imessageContinuationToken,
  isIMessageResetCommand,
  legacyIMessageContinuationTokens,
  renderUndeliveredIMessageInputRequests,
} from "../lib/imessage-session";
import { iMessageMarkdownSnapshots } from "../lib/imessage-stream";
import type { IMessageCommandResult } from "../lib/effect/imessage/schema";
import {
  iMessageVoiceReplyMode,
  isIMessageFeatureEnabled,
} from "../lib/imessage-feature-flags";

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
  /** The current human turn originated as a native voice memo. */
  voiceInput: boolean;
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

/** Native edit cadence. Intermediate markdown blocks are coalesced so a long
 * answer cannot turn into an unbounded number of provider operations. */
const STREAM_EDIT_INTERVAL_MS = 400;

/**
 * A capability URL for one inbound attachment, served by the router and
 * signed with this deployment's pairing secret. The URL contains no handle,
 * phone, provider GUID, or conversation id: only the random ref, expiry,
 * conversion mode, and HMAC.
 */
function signedAttachmentUrl(
  pairing: VerifiedPairing,
  file: InboundFileRef,
): URL {
  const mime = file.mimeType.toLowerCase();
  const access = {
    ref: file.id,
    convert: mime === "image/heic" || mime === "image/heif",
    expires: Math.floor((Date.now() + ATTACHMENT_URL_TTL_MS) / 1000),
  };
  const url = new URL(`${pairing.routerUrl}/api/imessage/attachment`);
  url.searchParams.set("ref", access.ref);
  if (access.convert) url.searchParams.set("convert", "jpeg");
  url.searchParams.set("expires", String(access.expires));
  url.searchParams.set("sig", signOpaqueAttachmentAccess(pairing.secret, access));
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

function maySafelyDowngrade(result: IMessageCommandResult): boolean {
  return (
    !result.ok &&
    (result.category === "unsupported" || result.category === "validation")
  );
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
      console.error("iMessage delivery lock release failed.", error);
    },
  );
}

async function deliverText(
  state: IMessageState,
  text: string,
  commandId?: string,
): Promise<void> {
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
        console.error("iMessage delivery lock acquisition failed.", error);
        return null;
      },
    );
    if (deliveryLockToken === null) {
      console.error("iMessage outbound dropped: the conversation stayed busy.");
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
    const target =
      space === undefined
        ? ({ kind: "dm", handle } as const)
        : ({ kind: "space", spaceId: space } as const);
    if (commandId !== undefined) {
      try {
        const voiceMode = await iMessageVoiceReplyMode();
        if ((state.voiceInput && voiceMode === "mirror") || voiceMode === "always") {
          const voice = await runTool(
            sendIMessageCommand({
              commandId: `${commandId}:send_voice`,
              phone: state.phone ?? "shared",
              target,
              operation: "send_voice",
              payload: { text },
            }),
          );
          if (voice.ok) {
            state.replied = true;
            return;
          }
        }
        const snapshots =
          space === undefined &&
          !isSingleUrl(text) &&
          (await isIMessageFeatureEnabled("imessage_streaming_edits"))
            ? iMessageMarkdownSnapshots(text)
            : [];
        if (snapshots.length > 1) {
          const first = await runTool(
            sendIMessageCommand({
              commandId: `${commandId}:stream:send`,
              phone: state.phone ?? "shared",
              target,
              operation: "send_markdown",
              payload: { text: snapshots[0] },
            }),
          );
          if (first.ok) {
            state.replied = true;
            let delivered = snapshots[0];
            if (first.messageRef !== undefined) {
              for (let index = 1; index < snapshots.length; index += 1) {
                await new Promise((resolve) =>
                  setTimeout(resolve, STREAM_EDIT_INTERVAL_MS),
                );
                const edited = await runTool(
                  sendIMessageCommand({
                    commandId: `${commandId}:stream:edit:${index}`,
                    phone: state.phone ?? "shared",
                    target,
                    operation: "edit",
                    payload: {
                      messageRef: first.messageRef,
                      text: snapshots[index],
                    },
                  }),
                );
                if (!edited.ok) {
                  if (!maySafelyDowngrade(edited)) {
                    throw new Error(
                      `native edit could not be reconciled (${edited.category})`,
                    );
                  }
                  break;
                }
                delivered = snapshots[index];
              }
            }
            const final = snapshots.at(-1) ?? text;
            if (delivered !== final) {
              const continuation = final.startsWith(delivered)
                ? final.slice(delivered.length).trimStart()
                : final;
              if (continuation.length > 0) {
                const remainder = await runTool(
                  sendIMessageCommand({
                    commandId: `${commandId}:stream:continuation`,
                    phone: state.phone ?? "shared",
                    target,
                    operation: "send_markdown",
                    payload: { text: continuation },
                  }),
                );
                if (!remainder.ok) {
                  throw new Error(
                    `continuation bubble failed (${remainder.category})`,
                  );
                }
              }
            }
            return;
          }
          if (!maySafelyDowngrade(first)) {
            throw new Error(
              `initial native reply could not be reconciled (${first.category})`,
            );
          }
        }
        const richOperation = space === undefined && isSingleUrl(text)
          ? "send_richlink"
          : "send_markdown";
        const rich = await runTool(
          sendIMessageCommand({
            commandId: `${commandId}:${richOperation}`,
            phone: state.phone ?? "shared",
            target,
            operation: richOperation,
            payload:
              richOperation === "send_richlink"
                ? { url: text.trim() }
                : { text },
          }),
        );
        if (rich.ok) {
          state.replied = true;
          return;
        }
        if (!maySafelyDowngrade(rich)) {
          throw new Error(
            `native reply could not be reconciled (${rich.category})`,
          );
        }
        const plain = await runTool(
          sendIMessageCommand({
            commandId: `${commandId}:send_text`,
            phone: state.phone ?? "shared",
            target,
            operation: "send_text",
            payload: { text },
          }),
        );
        if (plain.ok) {
          state.replied = true;
          return;
        }
        throw new Error(`plain reply failed (${plain.category})`);
      } catch {
        // The backward-compatible v1 path below is only for a pairing created
        // before deployment identities existed. A current v2 failure is
        // re-thrown so the durable inbound event retries the same commandId
        // instead of sending a second, untracked message.
        const pairing = await runTool(verifiedIMessagePairing()).catch(() => null);
        if (pairing?.deploymentUrl !== undefined) throw new Error(
          "the idempotent iMessage command did not complete",
        );
      }
    }
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
    console.error("iMessage outbound failed.", error);
    throw error;
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
    console.warn(`iMessage typing ${typing} failed.`, error);
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
    voiceInput: false,
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
    POST("/eve/v1/imessage/inbound", async (req, { reset, resolveActiveSession, send }) => {
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
      if (delivery.event !== "messages" && delivery.event !== "advanced") {
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
      if (handle.length === 0 && !isGroup) {
        console.error("iMessage inbound dropped: the message has no sender.");
        return Response.json({ ok: true, ignored: "sender" });
      }
      const isOwner = handle === pairing.handle;
      if (!isGroup && !isOwner) {
        console.error("iMessage inbound dropped: sender is not the paired owner.");
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
          console.error("iMessage inbound refused: the group is not owner-activated yet.");
          return new Response("Group space not activated on this deployment", { status: 409 });
        }
      }

      if (delivery.event === "advanced") {
        const arm =
          delivery.message.content !== null &&
          typeof delivery.message.content === "object"
            ? (delivery.message.content as Record<string, unknown>)
            : {};
        const eventType =
          typeof arm.eventType === "string" ? arm.eventType : "advanced.unknown";
        if (eventType === "message.edited" || eventType === "message.unsent") {
          await runTool(
            reconcileIMessageInbound({
              messageId: delivery.message.id,
              kind: eventType === "message.edited" ? "edited" : "unsent",
              ...(eventType === "message.edited" && typeof arm.text === "string"
                ? { text: arm.text }
                : {}),
            }),
          );
        }
        // State-only events never create a new Eve turn. Poll interaction
        // resumption is handled by the interaction service after ownership and
        // state-version checks.
        return Response.json({ ok: true, stateUpdated: eventType });
      }

      let content = renderInboundContent(delivery.message.content);
      const processedModelFiles: {
        readonly data: Buffer;
        readonly mediaType: string;
      }[] = [];
      const voiceInput = content.audio.some(
        (audio) => audio.isVoiceMemo !== false,
      );
      if (voiceInput) {
        if (!isGroup) {
          await runTool(
            sendIMessageTyping({
              handle: pairing.handle,
              state: "start",
              phone: delivery.space.phone,
            }),
          ).catch(() => undefined);
        }
        const transcripts: string[] = [];
        for (const audio of content.audio) {
          try {
            const response = await fetch(
              signedAttachmentUrl(pairing, audio),
              { redirect: "error", signal: AbortSignal.timeout(60_000) },
            );
            if (!response.ok) throw new Error(`voice download returned HTTP ${response.status}`);
            const transcript = await runTool(
              transcribeIMessageAudio(new Uint8Array(await response.arrayBuffer())),
            );
            transcripts.push(`[Voice memo transcript]\n${transcript.text}`);
          } catch {
            transcripts.push(
              "[Ruth could not transcribe this voice memo. Ask the sender to retry or type the request.]",
            );
          }
        }
        content = {
          ...content,
          text: [content.text, ...transcripts]
            .filter((value): value is string => value !== null)
            .join("\n\n"),
        };
      }
      if (content.processable.length > 0) {
        if (!isGroup) {
          await runTool(
            sendIMessageTyping({
              handle: pairing.handle,
              state: "start",
              phone: delivery.space.phone,
            }),
          ).catch(() => undefined);
        }
        const notes: string[] = [];
        for (const item of content.processable) {
          try {
            const response = await fetch(
              signedAttachmentUrl(pairing, item),
              { redirect: "error", signal: AbortSignal.timeout(120_000) },
            );
            if (!response.ok) {
              throw new Error(`media download returned HTTP ${response.status}`);
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (item.mimeType.startsWith("video/")) {
              const video = await runTool(
                extractIMessageVideo({ bytes, name: item.name }),
              );
              for (const frame of video.frames) {
                processedModelFiles.push({
                  data: Buffer.from(frame.jpeg),
                  mediaType: "image/jpeg",
                });
              }
              let transcript = "";
              if (video.audio !== undefined) {
                const audioTranscript = await runTool(
                  transcribeIMessageAudio(video.audio),
                );
                transcript =
                  audioTranscript.segments.length > 0
                    ? audioTranscript.segments
                        .map(
                          (segment) =>
                            `[${segment.startSecond.toFixed(1)}s–${segment.endSecond.toFixed(1)}s] ${segment.text}`,
                        )
                        .join("\n")
                    : audioTranscript.text;
              }
              notes.push(
                [
                  `[Video: ${item.name}, ${video.durationSeconds.toFixed(1)} seconds]`,
                  video.frames.length > 0
                    ? `Representative frames were extracted at ${video.frames
                        .map((frame) => `${frame.second.toFixed(1)}s`)
                        .join(", ")}.`
                    : "No representative frame could be extracted.",
                  transcript.length > 0
                    ? `[Time-aligned audio transcript]\n${transcript}`
                    : "No spoken audio transcript was available.",
                ].join("\n"),
              );
            } else {
              const document = await runTool(
                inspectIMessageArchive({ bytes, name: item.name }),
              );
              notes.push(
                document.extractedText !== undefined
                  ? `[Extracted document: ${item.name}]\n${document.extractedText}`
                  : `[Archive manifest: ${item.name}]\n${document.files
                      .map((file) => `${file.path} (${file.size} bytes)`)
                      .join("\n")}`,
              );
            }
          } catch {
            notes.push(
              `[Ruth could not safely process ${item.name}. Ask for a smaller or supported version.]`,
            );
          }
        }
        content = {
          ...content,
          text: [content.text, ...notes]
            .filter((value): value is string => value !== null)
            .join("\n\n"),
        };
      }
      if (
        content.text === null &&
        content.files.length === 0 &&
        content.audio.length === 0 &&
        processedModelFiles.length === 0
      ) {
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
          attachments: content.files.map((file) => ({
            name: file.name,
            mimeType: file.mimeType,
          })),
          chatType: isGroup ? "group" : "dm",
          role: isOwner ? "owner" : "guest",
          ...(delivery.space.phone !== undefined ? { phone: delivery.space.phone } : {}),
          receivedAtMs,
          routeReceivedAtMs,
        }),
      );
      if (claim === "done") return Response.json({ ok: true, ignored: "duplicate" });

      const sessionSpace = isGroup ? delivery.space.id : null;
      const continuationToken = imessageContinuationToken(
        pairing,
        delivery.space.phone ?? null,
        sessionSpace,
      );
      let dispatchToken = continuationToken;
      if ((await resolveActiveSession({ continuationToken })) === undefined) {
        for (const legacyToken of legacyIMessageContinuationTokens(pairing, sessionSpace)) {
          if ((await resolveActiveSession({ continuationToken: legacyToken })) !== undefined) {
            dispatchToken = legacyToken;
            break;
          }
        }
      }

      // A signed, owner-authored /new is the text-surface escape hatch for a
      // session parked on approval, authorization, or a bad historical turn.
      // Reset the legacy token too so deployments upgraded from the old
      // handle-only scheme do not leave an unreachable workflow running.
      if (
        isOwner &&
        isIMessageResetCommand(
          content.text,
          content.files.length > 0 || content.processable.length > 0,
        )
      ) {
        const legacyTokens = legacyIMessageContinuationTokens(pairing, sessionSpace);
        const deliveryLockToken = await acquireDeliveryLock(
          pairing.handle,
          delivery.space.id,
        ).catch((error: unknown) => {
          console.error("iMessage /new delivery lock failed.", error);
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
          for (const legacyToken of legacyTokens) {
            await reset({
              continuationToken: legacyToken,
              reason: "iMessage owner requested /new",
            });
          }
          if (isGroup) {
            await runTool(
              clearSafeGroupMemory(
                `group:${delivery.space.phone ?? "shared"}:${delivery.space.id}`,
              ),
            );
          }
          const confirmation = await runTool(
            sendIMessageCommand({
              commandId: `${delivery.message.id}:reset-confirmation`,
              phone: delivery.space.phone ?? "shared",
              target:
                sessionSpace === null
                  ? { kind: "dm", handle: pairing.handle }
                  : { kind: "space", spaceId: sessionSpace },
              operation: "send_text",
              payload: { text: "Started a fresh conversation." },
            }),
          );
          if (!confirmation.ok) {
            throw new Error(
              `reset confirmation failed (${confirmation.category})`,
            );
          }
          await runTool(
            recordIMessageInboundBatch([delivery.message.id], { status: "ok" }),
          ).catch((error: unknown) => {
            console.error("iMessage /new bookkeeping failed.", error);
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
      if (content.files.length === 0 && content.processable.length === 0) {
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
      const batchIds = settled.batch.map((entry) => entry.messageId);

      // Shared conversations never enter Ruth's private Eve runtime. Eve's
      // default harness capabilities are additive and cannot be removed
      // safely per turn, so every group participant — including the owner —
      // uses this deliberately tool-free, memory-free public-group runtime.
      // Consequential group administration is exposed separately through an
      // authenticated command surface.
      if (isGroup) {
        try {
          const reply = await runTool(
            generateSafeGroupReply({
              conversationKey: `group:${delivery.space.phone ?? "shared"}:${delivery.space.id}`,
              senderRole: isOwner ? "owner" : "participant",
              text: texts.join("\n"),
              attachmentNames: content.files.map((file) => file.name),
            }),
          );
          if (reply !== null) {
            let sent = await runTool(
              sendIMessageCommand({
                commandId: `${delivery.message.id}:isolated-group-reply`,
                phone: delivery.space.phone ?? "shared",
                target: { kind: "space", spaceId: delivery.space.id },
                operation: "send_markdown",
                payload: { text: reply },
              }),
            );
            if (maySafelyDowngrade(sent)) {
              sent = await runTool(
                sendIMessageCommand({
                  commandId: `${delivery.message.id}:isolated-group-reply:plain`,
                  phone: delivery.space.phone ?? "shared",
                  target: { kind: "space", spaceId: delivery.space.id },
                  operation: "send_text",
                  payload: { text: reply },
                }),
              );
            }
            if (!sent.ok) {
              throw new Error(`group reply failed (${sent.category})`);
            }
          }
          await runTool(recordIMessageInboundBatch(batchIds, { status: "ok" }));
          return Response.json({ ok: true, isolatedGroup: true });
        } catch (error) {
          await runTool(
            releaseIMessageInboundBatch({
              ownMessageId: delivery.message.id,
              batchMessageIds: batchIds,
            }),
          ).catch(() => undefined);
          console.error("iMessage isolated group turn failed.", error);
          return new Response("Group delivery failed", { status: 500 });
        }
      }

      const message = [
        ...(texts.length > 0 ? [{ type: "text" as const, text: texts.join("\n") }] : []),
        ...content.files.map((file) => ({
          type: "file" as const,
          data: signedAttachmentUrl(pairing, file),
          mediaType: forwardedMediaType(file.mimeType),
        })),
        ...processedModelFiles.map((file) => ({
          type: "file" as const,
          data: file.data,
          mediaType: file.mediaType,
        })),
      ];
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

      let sessionId: string;
      try {
        const session = await send(
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
                continuation_v2: continuationToken,
              },
            },
            // The pairing generation isolates a newly paired owner from old
            // sessions parked on approval or authorization under this handle.
            continuationToken: dispatchToken,
            state: {
              handle: pairing.handle,
              phone: delivery.space.phone ?? null,
              space: isGroup ? delivery.space.id : null,
              replied: false,
              inboundBatchIds: batchIds,
              conversationId: delivery.space.id,
              typingAt: 0,
              voiceInput,
            },
          },
        );
        sessionId = session.id;
      } catch (error) {
        // The batch's other texts go back to the queue; dropping this
        // message's own claim lets the router's retry reprocess it.
        await runTool(
          releaseIMessageInboundBatch({
            ownMessageId: delivery.message.id,
            batchMessageIds: batchIds,
            error: error instanceof Error ? error.message : String(error),
          }),
        ).catch(() => undefined);
        console.error("iMessage inbound delivery failed.", error);
        return new Response("Delivery failed", { status: 500 });
      }

      // The turn is dispatched; a bookkeeping miss must not trigger a retry
      // (the claims stand, so a retry would be dropped as a duplicate anyway).
      await runTool(recordIMessageInboundBatch(batchIds, { status: "ok", sessionId })).catch(
        (error: unknown) => {
          console.error("iMessage inbound bookkeeping failed.", error);
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
      continuationToken: imessageContinuationToken(pairing, phone, space),
      state: {
        handle,
        phone,
        space,
        replied: false,
        inboundBatchIds: null,
        conversationId: null,
        typingAt: 0,
        voiceInput: false,
      },
    });
  },

  events: {
    // Typing shows the moment Ruth starts working (same convention as eve's
    // Slack/Discord/Teams channels) and is re-asserted while tools run so the
    // bubble survives long turns. The reply itself clears it on the owner's
    // device; only a turn that ends without delivering any text stops it by
    // hand.
    async "turn.started"(_event, channel, ctx) {
      const migrationTarget =
        ctx.session.auth.current?.attributes.continuation_v2;
      if (
        typeof migrationTarget === "string" &&
        migrationTarget.length > 0 &&
        channel.continuationToken !== migrationTarget
      ) {
        channel.setContinuationToken(migrationTarget);
      }
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
    async "message.completed"(event, channel, ctx) {
      if (event.finishReason === "tool-calls" || !event.message) return;
      await deliverText(
        channel.state,
        event.message,
        `${ctx.session.id}:${event.turnId}:${event.stepIndex}`,
      );
    },
    async "input.requested"(event, channel, ctx) {
      const handle = channel.state.handle;
      const phone = channel.state.phone ?? "shared";
      const space = channel.state.space;
      const continuationToken = channel.continuationToken ?? "";
      let interactive = false;
      let deliveredNativeRequests = 0;
      if (handle !== null && continuationToken.length > 0) {
        interactive = true;
        const target =
          space === null
            ? ({ kind: "dm", handle } as const)
            : ({ kind: "space", spaceId: space } as const);
        for (const request of event.requests) {
          const nativePoll =
            request.display === "select" &&
            (request.options?.length ?? 0) >= 2 &&
            (request.options?.length ?? 0) <= 10 &&
            request.allowFreeform !== true;
          // The v2 command service already retries transport loss with this
          // exact commandId. If both acknowledgements are lost, let the
          // handler fail instead of sending the same prompt through a
          // different plaintext command whose delivery could duplicate it.
          const sent = await runTool(
            sendIMessageCommand({
              commandId: `${ctx.session.id}:input:${request.requestId}:${
                nativePoll ? "poll" : "app"
              }`,
              phone,
              target,
              operation: nativePoll ? "send_poll" : "send_app",
              payload: nativePoll
                ? {
                    title: request.prompt,
                    choices: request.options?.map((option) => option.label) ?? [],
                    kind: "native_poll",
                    sensitive: false,
                    eveRequestId: request.requestId,
                    state: {
                      title: request.prompt,
                      options: request.options?.map((option) => ({
                        id: option.id,
                        label: option.label,
                        detail: option.description,
                      })),
                      sessionId: ctx.session.id,
                      continuationToken,
                    },
                  }
                : {
                    kind:
                      request.display === "confirmation"
                        ? "approval"
                        : request.display === "text"
                          ? "form"
                          : "choice",
                    sensitive: request.display === "confirmation",
                    live: false,
                    caption: request.prompt,
                    summary: "Respond without leaving Messages",
                    eveRequestId: request.requestId,
                    state: {
                      title: request.prompt,
                      description:
                        request.display === "confirmation"
                          ? "This action needs the separate Ruth owner authorization secret."
                          : "Your response resumes this exact Ruth request.",
                      options:
                        request.options?.map((option) => ({
                          id: option.id,
                          label: option.label,
                          detail: option.description,
                        })) ??
                        (request.display === "confirmation"
                          ? [
                              { id: "approve", label: "Approve" },
                              { id: "deny", label: "Decline" },
                            ]
                          : []),
                      allowFreeform: request.allowFreeform === true,
                      sessionId: ctx.session.id,
                      continuationToken,
                    },
                  },
            }),
          );
          if (!sent.ok) {
            interactive = false;
            break;
          }
          deliveredNativeRequests += 1;
          channel.state.replied = true;
        }
      }
      if (!interactive) {
        const fallback = renderUndeliveredIMessageInputRequests(
          event.requests,
          deliveredNativeRequests,
        );
        if (fallback === null) return;
        await deliverText(
          channel.state,
          fallback,
          `${ctx.session.id}:input:${event.stepIndex}`,
        );
      }
    },
    async "turn.failed"(_event, channel) {
      await deliverText(
        channel.state,
        "I hit an error while handling that. Please try again, or rephrase.",
      );
    },
  },
});
