import { Effect } from "effect";

import {
  IMessageError,
  bindIMessageChat,
  bindIMessageSpace,
  isUsableIMessageProviderId,
  lookupIMessageChat,
  lookupIMessageRegistration,
  lookupIMessageSpace,
  markIMessageInboundRead,
  normalizeHandle,
  parseSpectrumDelivery,
  shareIMessageContactAfterFirstInbound,
} from "../imessage";
import {
  ROUTER_SIGNATURE_HEADER,
  ROUTER_TIMESTAMP_HEADER,
  signV0,
} from "../../imessage-signature";
import { fetchValidatedDeployment } from "./security";
import { registerIMessageRef } from "./store";

const FORWARD_TIMEOUT_MS = 240_000;

export interface RouterDeliveryOutcome {
  readonly accepted: boolean;
  readonly ignored?: "event" | "sender" | "unpaired";
}

function forwardFailure(cause: unknown): IMessageError {
  return new IMessageError({
    reason: "router",
    detail: cause instanceof Error ? cause.message : String(cause),
  });
}

export function attachmentIds(content: unknown): readonly string[] {
  if (content === null || typeof content !== "object") return [];
  const arm = content as { type?: unknown; id?: unknown; items?: unknown };
  if (arm.type === "attachment" || arm.type === "voice") {
    return isUsableIMessageProviderId(arm.id) ? [arm.id] : [];
  }
  if (arm.type !== "group" || !Array.isArray(arm.items)) return [];
  return arm.items.flatMap((item) =>
    item !== null && typeof item === "object" && "content" in item
      ? attachmentIds((item as { content?: unknown }).content)
      : [],
  );
}

export function replaceAttachmentIds(
  content: unknown,
  refs: ReadonlyMap<string, string>,
): unknown {
  if (content === null || typeof content !== "object") return content;
  const arm = content as Record<string, unknown>;
  if (
    (arm.type === "attachment" || arm.type === "voice") &&
    isUsableIMessageProviderId(arm.id)
  ) {
    return { ...arm, id: refs.get(arm.id) ?? arm.id };
  }
  if (arm.type !== "group" || !Array.isArray(arm.items)) return content;
  return {
    ...arm,
    items: arm.items.map((item) =>
      item !== null && typeof item === "object" && "content" in item
        ? {
            ...(item as Record<string, unknown>),
            content: replaceAttachmentIds(
              (item as { content?: unknown }).content,
              refs,
            ),
          }
        : item,
    ),
  };
}

/**
 * Processes one already-authenticated Spectrum payload from the durable inbox.
 * It deliberately contains no raw-body logging and revalidates the callback
 * hostname immediately before every forward.
 */
export function processIMessageRouterDelivery(
  rawBody: string,
) {
  return Effect.gen(function* () {
    const delivery = parseSpectrumDelivery(rawBody);
    if (delivery === null) {
      return yield* Effect.fail(
        new IMessageError({ reason: "validation", detail: "invalid queued Spectrum payload" }),
      );
    }
    if (delivery.event !== "messages" && delivery.event !== "advanced") {
      return { accepted: false, ignored: "event" };
    }

    const sender = delivery.message.sender?.id ?? "";
    let handle = normalizeHandle(sender) ?? sender;
    const isGroup = (delivery.space.type ?? "dm") === "group";
    const phone = delivery.space.phone?.trim() || "shared";

    let registration: { deploymentUrl: string; secret: string } | null = null;
    if (isGroup) {
      const existing = yield* lookupIMessageSpace(delivery.space.id);
      if (existing !== null) {
        registration = {
          deploymentUrl: existing.deploymentUrl,
          secret: existing.secret,
        };
      } else if (handle.length > 0) {
        const senderRegistration = yield* lookupIMessageRegistration(handle);
        if (senderRegistration !== null) {
          yield* bindIMessageSpace({ spaceId: delivery.space.id, handle });
          const claimed = yield* lookupIMessageSpace(delivery.space.id);
          registration =
            claimed === null
              ? senderRegistration
              : {
                  deploymentUrl: claimed.deploymentUrl,
                  secret: claimed.secret,
                };
        }
      }
    } else {
      if (handle.length > 0) {
        registration = yield* lookupIMessageRegistration(handle);
        if (registration !== null) {
          yield* bindIMessageChat({
            phone,
            chatId: delivery.space.id,
            handle,
          });
        }
      } else if (delivery.event === "advanced") {
        const chat = yield* lookupIMessageChat({
          phone,
          chatId: delivery.space.id,
        });
        if (chat !== null) {
          handle = chat.handle;
          registration = {
            deploymentUrl: chat.deploymentUrl,
            secret: chat.secret,
          };
        }
      } else {
        return { accepted: false, ignored: "sender" };
      }
    }

    if (registration === null) {
      // Photon lines are conversational, not public authentication inboxes.
      // Unknown senders stay silent and no agent turn is created.
      return { accepted: false, ignored: "unpaired" };
    }
    const conversationKey = isGroup
      ? `space:${phone}:${delivery.space.id}`
      : `dm:${phone}:${handle}`;

    const timestamp = String(Math.floor(Date.now() / 1000));
    const messageRef = yield* registerIMessageRef({
      providerMessageId: delivery.message.id,
      phone,
      conversationKey,
      direction: "inbound",
      contentType:
        delivery.message.content !== null &&
        typeof delivery.message.content === "object" &&
        "type" in delivery.message.content &&
        typeof (delivery.message.content as { type?: unknown }).type === "string"
          ? (delivery.message.content as { type: string }).type
          : "unknown",
    });
    const boundAttachments = new Map<string, string>();
    for (const providerAttachmentId of attachmentIds(delivery.message.content)) {
      const attachmentRef = yield* registerIMessageRef({
        providerMessageId: providerAttachmentId,
        phone,
        conversationKey,
        direction: "inbound",
        contentType: "attachment",
      });
      boundAttachments.set(providerAttachmentId, attachmentRef);
    }
    const forwardBody = yield* Effect.try({
      try: () => {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        const message =
          parsed.message !== null && typeof parsed.message === "object"
            ? (parsed.message as Record<string, unknown>)
            : {};
        const content = replaceAttachmentIds(
          message.content,
          boundAttachments,
        );
        return JSON.stringify({
          ...parsed,
          message: { ...message, id: messageRef, content },
        });
      },
      catch: forwardFailure,
    });
    const forwarded = yield* Effect.tryPromise({
      try: () =>
        fetchValidatedDeployment(
          registration.deploymentUrl,
          "/eve/v1/imessage/inbound",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [ROUTER_TIMESTAMP_HEADER]: timestamp,
              [ROUTER_SIGNATURE_HEADER]: signV0(
                registration.secret,
                timestamp,
                forwardBody,
              ),
            },
            body: forwardBody,
            signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
          },
        ),
      catch: forwardFailure,
    });
    if (!forwarded.ok) {
      return yield* Effect.fail(
        new IMessageError({
          reason: "router",
          detail: `paired deployment answered HTTP ${forwarded.status}`,
          status: forwarded.status,
        }),
      );
    }
    const response = yield* Effect.tryPromise({
      try: () => forwarded.json().catch(() => null),
      catch: forwardFailure,
    });
    const ignored =
      response !== null &&
      typeof response === "object" &&
      "ignored" in response;
    const accepted = !ignored;

    if (accepted && !isGroup && delivery.event === "messages") {
      yield* markIMessageInboundRead({
        handle,
        messageId: delivery.message.id,
        ...(delivery.space.phone !== undefined
          ? { phone: delivery.space.phone }
          : {}),
      }).pipe(
        Effect.catch(() => Effect.void),
      );
      yield* shareIMessageContactAfterFirstInbound({
        handle,
        ...(delivery.space.phone !== undefined
          ? { phone: delivery.space.phone }
          : {}),
      }).pipe(Effect.catch(() => Effect.void));
    }

    return { accepted };
  });
}
