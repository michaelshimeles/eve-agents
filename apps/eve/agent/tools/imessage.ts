import { isChannel } from "eve/instrumentation";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import imessage from "../channels/imessage";
import {
  sendIMessageCommand,
  verifiedIMessagePairing,
} from "../lib/effect/imessage";
import {
  type IMessageOperation,
  sensitiveCommandPayloadHash,
} from "../lib/effect/imessage/schema";
import { runTool } from "../lib/effect/runtime";

// First-class iMessage primitives. Every tool closes over the authenticated
// conversation target and sends through the v2 router command plane; the model
// never receives a provider GUID or gets to choose a phone/space.

const httpUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", {
  message: "Use a public HTTPS URL",
});

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!isChannel(ctx.channel, imessage)) return null;
      const { handle, phone, space } = ctx.channel.metadata;
      if (handle === null || handle.length === 0 || space !== null) return null;
      const line = phone ?? "shared";
      const target = { kind: "dm" as const, handle };
      const attributes = ctx.session.auth.current?.attributes ?? {};
      const continuationToken =
        typeof attributes.continuation_v2 === "string"
          ? attributes.continuation_v2
          : undefined;
      const rawMessageRef = (attributes as Record<string, unknown>).message_id;
      const inboundMessageRef =
        typeof rawMessageRef === "string" && rawMessageRef.startsWith("imr_")
          ? rawMessageRef
          : null;

      async function command(
        operation: IMessageOperation,
        payload: unknown,
        toolContext: { readonly callId: string; readonly session: { readonly id: string } },
        commandId?: string,
      ) {
        const result = await runTool(
          sendIMessageCommand({
            commandId:
              commandId ??
              `${toolContext.session.id}:${toolContext.callId}:${operation}`,
            phone: line,
            target,
            operation,
            payload,
          }),
        );
        if (!result.ok) throw new Error(result.message);
        return result;
      }

      async function routerOperation(
        body: Record<string, unknown>,
      ): Promise<Record<string, unknown>> {
        const pairing = await runTool(verifiedIMessagePairing());
        if (pairing === null) throw new Error("iMessage is not paired");
        const response = await fetch(
          `${pairing.routerUrl.replace(/\/+$/, "")}/api/imessage/operations`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${pairing.secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(20_000),
          },
        );
        const result = (await response.json().catch(() => null)) as
          | Record<string, unknown>
          | null;
        if (!response.ok) {
          throw new Error(
            typeof result?.error === "string"
              ? result.error
              : `iMessage router answered HTTP ${response.status}`,
          );
        }
        return result ?? {};
      }

      return {
        ...(inboundMessageRef === null
          ? {}
          : {
              react: defineTool({
                description:
                  "Add a native tapback or arbitrary emoji reaction to the owner's current iMessage. Use a reaction when it communicates better than another sentence.",
                inputSchema: z.object({
                  emoji: z.string().min(1).max(16),
                }),
                execute: ({ emoji }, toolCtx) =>
                  command(
                    "react",
                    { messageRef: inboundMessageRef, reaction: emoji },
                    toolCtx,
                  ),
              }),
              remove_reaction: defineTool({
                description:
                  "Remove Ruth's matching reaction from the owner's current iMessage.",
                inputSchema: z.object({
                  emoji: z.string().min(1).max(16),
                }),
                execute: ({ emoji }, toolCtx) =>
                  command(
                    "remove_reaction",
                    { messageRef: inboundMessageRef, reaction: emoji },
                    toolCtx,
                  ),
              }),
              reply_to_message: defineTool({
                description:
                  "Send a native threaded reply to the owner's current iMessage. The reply is delivered immediately, so do not repeat it in the final answer.",
                inputSchema: z.object({ text: z.string().min(1).max(12_000) }),
                execute: ({ text }, toolCtx) =>
                  command(
                    "reply",
                    { messageRef: inboundMessageRef, text },
                    toolCtx,
                  ),
              }),
              place_sticker: defineTool({
                description:
                  "Place a native sticker image on the owner's current iMessage. Use only when they asked for a sticker or it clearly fits the moment.",
                inputSchema: z.object({
                  url: httpUrl,
                  name: z.string().max(120).optional(),
                  x: z.number().min(0).max(1).default(0.5),
                  y: z.number().min(0).max(1).default(0.5),
                  scale: z.number().min(0.1).max(3).optional(),
                  rotation: z.number().min(-6.2832).max(6.2832).optional(),
                  width: z.number().min(1).max(1024).optional(),
                  partIndex: z.number().int().min(0).max(1000).optional(),
                }),
                execute: (input, toolCtx) =>
                  command(
                    "place_sticker",
                    { ...input, messageRef: inboundMessageRef },
                    toolCtx,
                  ),
              }),
            }),

        send_effect: defineTool({
          description:
            "Send a separate native iMessage with an Apple bubble or screen effect. Reserve this for a moment that deserves it and do not repeat the text afterward.",
          inputSchema: z.object({
            text: z.string().min(1).max(12_000),
            effect: z.enum([
              "slam",
              "loud",
              "gentle",
              "invisible",
              "confetti",
              "fireworks",
              "balloons",
              "heart",
              "lasers",
              "celebration",
              "sparkles",
              "spotlight",
              "echo",
            ]),
          }),
          execute: (input, toolCtx) => command("send_effect", input, toolCtx),
        }),

        send_voice_memo: defineTool({
          description:
            "Speak text as a native Ruth voice memo. Use when the owner asks for audio or when a spoken answer is clearly preferable. Do not repeat the same answer in text.",
          inputSchema: z.object({ text: z.string().min(1).max(12_000) }),
          execute: (input, toolCtx) => command("send_voice", input, toolCtx),
        }),

        send_album: defineTool({
          description:
            "Send two to ten public HTTPS images or files as one native iMessage album.",
          inputSchema: z.object({
            urls: z.array(httpUrl).min(2).max(10),
          }),
          execute: (input, toolCtx) => command("send_album", input, toolCtx),
        }),

        send_contact: defineTool({
          description: "Send a native contact card in iMessage.",
          inputSchema: z.object({
            name: z.string().max(200).optional(),
            phones: z.array(z.string().max(120)).max(10).optional(),
            emails: z.array(z.string().email()).max(10).optional(),
            vcard: z.string().max(64_000).optional(),
          }),
          execute: (input, toolCtx) => command("send_contact", input, toolCtx),
        }),

        send_rich_link: defineTool({
          description:
            "Send a native rich-link preview card for a public HTTPS URL instead of pasting a bare link.",
          inputSchema: z.object({ url: httpUrl }),
          execute: (input, toolCtx) => command("send_richlink", input, toolCtx),
        }),

        send_poll: defineTool({
          description:
            "Send a native iMessage poll with two to ten choices. Use for a real group or owner decision, not as decorative formatting.",
          inputSchema: z.object({
            title: z.string().min(1).max(240),
            choices: z.array(z.string().min(1).max(120)).min(2).max(10),
          }),
          execute: (input, toolCtx) =>
            command(
              "send_poll",
              {
                ...input,
                kind: "native_poll",
                eveRequestId: toolCtx.callId,
                state: {
                  sessionId: toolCtx.session.id,
                  continuationToken,
                  options: input.choices.map((label, index) => ({
                    id: `option-${index + 1}`,
                    label,
                  })),
                },
              },
              toolCtx,
            ),
        }),

        send_interactive_card: defineTool({
          description:
            "Send a Photon Mini App card for an ordinary non-sensitive choice, multi-step form, schedule, artifact preview, or progress display.",
          inputSchema: z.object({
            kind: z.enum(["choice", "form", "schedule", "artifact", "progress", "status"]),
            title: z.string().min(1).max(240),
            body: z.string().max(2_000).optional(),
            options: z
              .array(
                z.object({
                  id: z.string().min(1).max(120),
                  label: z.string().min(1).max(120),
                }),
              )
              .max(20)
              .optional(),
          }),
          execute: (input, toolCtx) =>
            command(
              "send_app",
              {
                kind: input.kind,
                caption: input.title,
                summary: input.body ?? input.title,
                live: input.kind === "progress" || input.kind === "status",
                eveRequestId: toolCtx.callId,
                state: {
                  kind: input.kind,
                  title: input.title,
                  description: input.body,
                  options: input.options,
                  sessionId: toolCtx.session.id,
                  continuationToken,
                },
              },
              toolCtx,
            ),
        }),

        update_interactive_card: defineTool({
          description:
            "Update a previously sent Ruth Mini App bubble in place using its opaque message reference. Use for progress or status changes.",
          inputSchema: z.object({
            messageRef: z.string().startsWith("imr_"),
            title: z.string().min(1).max(240),
            body: z.string().max(2_000).optional(),
            live: z.boolean().default(true),
          }),
          execute: (input, toolCtx) =>
            command(
              "update_app",
              {
                messageRef: input.messageRef,
                caption: input.title,
                summary: input.body ?? input.title,
                live: input.live,
              },
              toolCtx,
            ),
        }),

        edit_ruth_message: defineTool({
          description:
            "Edit a recent Ruth-authored iMessage using the opaque message reference returned by another iMessage tool.",
          inputSchema: z.object({
            messageRef: z.string().startsWith("imr_"),
            text: z.string().min(1).max(12_000),
          }),
          execute: (input, toolCtx) => command("edit", input, toolCtx),
        }),

        unsend_ruth_message: defineTool({
          description:
            "Unsend a recent Ruth-authored iMessage using the opaque message reference returned by another iMessage tool. Use only when the owner asks or the send was clearly erroneous.",
          inputSchema: z.object({
            messageRef: z.string().startsWith("imr_"),
          }),
          execute: (input, toolCtx) => command("unsend", input, toolCtx),
        }),

        set_chat_background: defineTool({
          description:
            "Set or clear this direct iMessage conversation's native background. Only do this when the owner asks.",
          inputSchema: z.union([
            z.object({ url: httpUrl }),
            z.object({ clear: z.literal(true) }),
          ]),
          execute: (input, toolCtx) =>
            "clear" in input
              ? command("remove_background", {}, toolCtx)
              : command("set_background", { url: input.url }, toolCtx),
        }),

        share_ruth_contact: defineTool({
          description:
            "Share Ruth's configured native contact information in this conversation. Best after the initial exchange, never as a cold opener.",
          inputSchema: z.object({}),
          execute: (_input, toolCtx) => command("share_contact", {}, toolCtx),
        }),

        request_sensitive_imessage_approval: defineTool({
          description:
            "Send a separately authenticated Ruth Mini App approval for one location request or one Notify Anyway action. This only records the owner's decision; wait for the owner to approve and message again before executing it.",
          inputSchema: z.object({
            operation: z.enum(["request_location", "notify_anyway"]),
            summary: z.string().min(1).max(500),
            durationSeconds: z.number().int().min(30).max(900).optional(),
          }),
          execute: async ({ operation, summary, durationSeconds }, toolCtx) => {
            if (operation === "notify_anyway" && inboundMessageRef === null) {
              throw new Error("Notify Anyway requires the current inbound message");
            }
            const approvedCommandId =
              `${toolCtx.session.id}:${toolCtx.callId}:${operation}:authorized`;
            const approvedPayload =
              operation === "request_location"
                ? {
                    address: handle,
                    durationSeconds: durationSeconds ?? 15 * 60,
                  }
                : { messageRef: inboundMessageRef };
            const approval = await command(
              "send_app",
              {
                kind: "imessage_command_approval",
                caption: "Approve iMessage action",
                summary,
                sensitive: true,
                eveRequestId: toolCtx.callId,
                state: {
                  title: "Approve iMessage action",
                  description: summary,
                  options: [
                    { id: "approve", label: "Approve" },
                    { id: "deny", label: "Decline" },
                  ],
                  commandId: approvedCommandId,
                  operation,
                  payloadHash: sensitiveCommandPayloadHash(
                    operation,
                    approvedPayload,
                  ),
                },
              },
              toolCtx,
            );
            const interactionId =
              typeof approval.result?.interactionId === "string"
                ? approval.result.interactionId
                : "";
            if (interactionId.length === 0) {
              throw new Error("Ruth could not bind the approval interaction");
            }
            return {
              messageRef: approval.messageRef,
              interactionId,
              approvedCommandId,
              approvedPayload,
              instruction:
                "Wait for the owner to approve this card and send a new message before executing the action.",
            };
          },
        }),

        execute_approved_imessage_action: defineTool({
          description:
            "Execute a location request or one-shot Notify Anyway only after the owner approved the matching Ruth card and then asked to continue.",
          inputSchema: z.object({
            operation: z.enum(["request_location", "notify_anyway"]),
            interactionId: z.string().uuid(),
            approvedCommandId: z.string().min(1).max(500),
            durationSeconds: z.number().int().min(30).max(900).optional(),
            messageRef: z.string().startsWith("imr_").optional(),
          }),
          execute: ({
            operation,
            interactionId,
            approvedCommandId,
            durationSeconds,
            messageRef,
          }, toolCtx) => {
            if (operation === "notify_anyway" && messageRef === undefined) {
              throw new Error("Notify Anyway requires the approved message reference");
            }
            const approvedPayload = {
                ...(operation === "request_location"
                  ? {
                      address: handle,
                      durationSeconds: durationSeconds ?? 15 * 60,
                    }
                  : { messageRef }),
            };
            return command(
              operation,
              {
                ...approvedPayload,
                approval: { interactionId },
              },
              toolCtx,
              approvedCommandId,
            );
          },
        }),

        read_shared_location: defineTool({
          description:
            "Read the latest encrypted-and-short-lived Find My snapshot after the owner explicitly initiated location sharing. This never starts a new location request.",
          inputSchema: z.object({}),
          execute: () =>
            routerOperation({
              action: "read_latest_location",
              phone: line,
            }),
        }),

        stop_shared_location: defineTool({
          description:
            "Stop an active owner-authorized location watch and delete its latest snapshot.",
          inputSchema: z.object({
            watchId: z.string().uuid(),
          }),
          execute: ({ watchId }) =>
            routerOperation({
              action: "stop_location",
              id: watchId,
            }),
        }),
      };
    },
  },
});
