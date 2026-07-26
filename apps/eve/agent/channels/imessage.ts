import { POST, defineChannel } from "eve/channels";

import {
  claimIMessageInbound,
  normalizeHandle,
  parseSpectrumDelivery,
  recordIMessageInbound,
  releaseIMessageInbound,
  renderInboundText,
  sendIMessageReply,
  verifiedIMessagePairing,
} from "../lib/effect/imessage";
import { runTool } from "../lib/effect/runtime";
import {
  ROUTER_SIGNATURE_HEADER,
  ROUTER_TIMESTAMP_HEADER,
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
}

async function deliverText(state: IMessageState, text: string): Promise<void> {
  const handle = state.handle;
  if (handle === null || handle.length === 0) {
    console.error("iMessage outbound dropped: the session has no handle.");
    return;
  }
  try {
    await runTool(sendIMessageReply({ handle, text, phone: state.phone ?? undefined }));
  } catch (error) {
    console.error(`iMessage outbound to ${handle} failed.`, error);
  }
}

export default defineChannel<IMessageState, { state: IMessageState }, { handle?: string; phone?: string }>({
  state: { handle: null, phone: null },

  context(state) {
    return { state };
  },

  metadata(state) {
    return { handle: state.handle };
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

      const text = renderInboundText(delivery.message.content);
      if (text === null) return Response.json({ ok: true, ignored: "content" });

      // Synchronous on purpose: a failure here must surface as a 5xx so the
      // router (and Spectrum behind it) retries instead of losing the text.
      const claimed = await runTool(
        claimIMessageInbound({
          messageId: delivery.message.id,
          spaceId: delivery.space.id,
          handle,
        }),
      );
      if (!claimed) return Response.json({ ok: true, ignored: "duplicate" });

      try {
        await send(
          {
            message: text,
            context: [
              `This message arrived over iMessage from ${handle} — the owner texting the shared line. Space ${delivery.space.id}.`,
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
                ...(delivery.space.phone !== undefined ? { line_phone: delivery.space.phone } : {}),
              },
            },
            continuationToken: handle,
            state: { handle, phone: delivery.space.phone ?? null },
          },
        );
      } catch (error) {
        // Drop the claim so the router's retry reprocesses the message.
        await runTool(releaseIMessageInbound(delivery.message.id)).catch(() => undefined);
        console.error(`iMessage inbound ${delivery.message.id} failed.`, error);
        return new Response("Delivery failed", { status: 500 });
      }

      // The turn is dispatched; a bookkeeping miss must not trigger a retry
      // (the claim stands, so a retry would be dropped as a duplicate anyway).
      await runTool(recordIMessageInbound(delivery.message.id, { status: "ok" })).catch(
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
      state: { handle, phone },
    });
  },

  events: {
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
