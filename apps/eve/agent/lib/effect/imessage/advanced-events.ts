import { randomUUID } from "node:crypto";

import type {
  CatchUpEvent,
  Chat,
  LiveEvent,
  Message,
  TypedEventStream,
} from "@photon-ai/advanced-imessage/grpc";
import { start } from "workflow/api";

import { imessageIngressWorkflow } from "@/app/workflows/imessage-ingress";
import { imessageInteractionResumeWorkflow } from "@/app/workflows/imessage-interaction-resume";
import { runApp } from "../runtime";
import {
  advancedIMessageSupportsPhone,
  withAdvancedIMessageClient,
} from "./advanced";
import { recordIMessagePollVote } from "./polls";
import {
  acquireIMessageProviderLease,
  advanceIMessageProviderCursor,
  enqueueIMessageIngress,
  releaseIMessageProviderLease,
  renewIMessageProviderLease,
} from "./store";

const EVENT_STREAM = "advanced-all";
const LEASE_SECONDS = 270;
const SEGMENT_MS = 220_000;

interface QueueWaiter<T> {
  readonly resolve: (value: T | null) => void;
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter.resolve(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve(null);
  }

  async shift(timeoutMs: number): Promise<T | null> {
    const value = this.values.shift();
    if (value !== undefined) return value;
    if (this.closed) return null;
    return new Promise<T | null>((resolve) => {
      const waiter = { resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
    });
  }
}

export function takeNextContiguousEvent<T extends { readonly sequence: number }>(
  pending: Map<number, T>,
  lastContiguousSequence: number,
): T | undefined {
  const next = pending.get(lastContiguousSequence + 1);
  if (next !== undefined) pending.delete(lastContiguousSequence + 1);
  return next;
}

function eventMessageId(event: LiveEvent): string {
  switch (event.type) {
    case "message.received":
      return event.message.guid;
    case "message.edited":
    case "message.read":
    case "message.unsent":
    case "message.reactionAdded":
    case "message.reactionRemoved":
    case "message.stickerPlaced":
      return event.messageGuid;
    case "poll.changed":
      return event.pollMessageGuid;
    default:
      return `advanced:${event.type}:${event.sequence}`;
  }
}

function spectrumContent(message: Message): unknown {
  const arms: unknown[] = [];
  if (message.content.text !== undefined && message.content.text.trim().length > 0) {
    arms.push({ type: "text", text: message.content.text });
  }
  for (const item of message.content.attachments) {
    arms.push({
      type: "attachment",
      id: item.guid,
      name: item.fileName,
      mimeType: item.mimeType,
      size: item.totalBytes,
      isAudioMessage: message.isAudioMessage,
    });
  }
  if (arms.length === 0) return { type: "advanced_event", eventType: "message.received" };
  if (arms.length === 1) return arms[0];
  return {
    type: "group",
    items: arms.map((content) => ({ content })),
  };
}

function stateContent(event: Exclude<LiveEvent, { readonly type: "message.received" }>): unknown {
  switch (event.type) {
    case "message.edited":
      return {
        type: "advanced_event",
        eventType: event.type,
        text: event.content.text ?? "",
        editedAt: event.editedAt.toISOString(),
      };
    case "message.read":
      return {
        type: "advanced_event",
        eventType: event.type,
        readAt: event.readAt.toISOString(),
      };
    case "message.unsent":
      return {
        type: "advanced_event",
        eventType: event.type,
        retractedAt: event.retractedAt.toISOString(),
      };
    case "message.reactionAdded":
    case "message.reactionRemoved":
      return {
        type: "advanced_event",
        eventType: event.type,
        reaction: event.reaction,
        partIndex: event.targetPartIndex,
      };
    case "message.stickerPlaced":
      return {
        type: "advanced_event",
        eventType: event.type,
        sticker:
          event.sticker === undefined
            ? undefined
            : {
                name: event.sticker.fileName,
                mimeType: event.sticker.mimeType,
                size: event.sticker.totalBytes,
              },
        placement: event.placement,
        partIndex: event.targetPartIndex,
      };
    case "poll.changed":
      return {
        type: "advanced_event",
        eventType: event.type,
        change: event.delta,
      };
    case "group.changed":
      return {
        type: "advanced_event",
        eventType: event.type,
        change: event.change,
      };
    default:
      return { type: "advanced_event", eventType: event.type };
  }
}

function deliveryFor(event: LiveEvent, phone: string, chat: Chat): string {
  const sender =
    event.type === "message.received"
      ? event.message.sender?.address ?? event.actor?.address
      : event.actor?.address;
  const content =
    event.type === "message.received" ? spectrumContent(event.message) : stateContent(event);
  return JSON.stringify({
    event: event.type === "message.received" ? "messages" : "advanced",
    sequence: event.sequence,
    space: {
      id: event.chatGuid,
      type: chat.isGroup ? "group" : "dm",
      phone,
    },
    message: {
      id: eventMessageId(event),
      timestamp: event.occurredAt.toISOString(),
      ...(sender === undefined ? {} : { sender: { id: sender } }),
      content,
    },
  });
}

async function consume<T>(
  stream: TypedEventStream<T>,
  queue: AsyncQueue<T>,
): Promise<void> {
  try {
    for await (const event of stream) queue.push(event);
  } finally {
    await stream.close();
  }
}

/**
 * Runs one bounded Advanced Kit stream segment. Live subscriptions are
 * attached before catch-up starts; sequence ordering and persisted cursor
 * advancement happen only after a contiguous event has entered the inbox.
 */
export async function runAdvancedIMessageEventSegment(
  phone: string,
  workerId: string,
): Promise<{
  readonly status: "busy" | "complete";
  readonly advancedTo: number;
  readonly catchupHead: number | null;
  readonly gap: number | null;
}> {
  if (!advancedIMessageSupportsPhone(phone)) {
    throw new Error("Advanced iMessage event pump phone is not the configured line");
  }
  const cursor = await runApp(
    acquireIMessageProviderLease({
      phone,
      eventStream: EVENT_STREAM,
      workerId,
      leaseSeconds: LEASE_SECONDS,
    }),
  );
  if (cursor === null) {
    return { status: "busy", advancedTo: 0, catchupHead: null, gap: null };
  }

  let contiguous = cursor.lastContiguousSequence;
  let catchupHead: number | null = null;
  const pending = new Map<number, LiveEvent>();
  const deadline = Date.now() + SEGMENT_MS;
  let lastLeaseRenewal = Date.now();

  try {
    await withAdvancedIMessageClient(async (client) => {
      const queue = new AsyncQueue<CatchUpEvent>();
      const streams: TypedEventStream<LiveEvent>[] = [
        client.messages.subscribeEvents(),
        client.chats.subscribeEvents(),
        client.groups.subscribeEvents(),
        client.polls.subscribeEvents(),
      ];
      let producerFailure: unknown = null;
      const producers = streams.map(async (stream) => {
        try {
          await consume(stream, queue);
          throw new Error("Photon Advanced live event stream ended unexpectedly");
        } catch (cause) {
          producerFailure ??= cause;
          queue.close();
        }
      });
      const catchup = client.events.catchUp(contiguous);
      producers.push(
        consume(catchup, queue).catch((cause: unknown) => {
          producerFailure ??= cause;
          queue.close();
        }),
      );
      const chats = new Map<string, Chat>();

      try {
        while (Date.now() < deadline) {
          if (Date.now() - lastLeaseRenewal >= 60_000) {
            const renewed = await runApp(
              renewIMessageProviderLease({
                phone,
                eventStream: EVENT_STREAM,
                workerId,
                leaseSeconds: LEASE_SECONDS,
              }),
            );
            if (!renewed) throw new Error("Advanced iMessage provider lease was lost");
            lastLeaseRenewal = Date.now();
          }
          const event = await queue.shift(Math.min(5_000, deadline - Date.now()));
          if (event === null) {
            if (producerFailure !== null) throw producerFailure;
            continue;
          }
          if (event.type === "catchup.complete") {
            catchupHead = event.headSequence;
            continue;
          }
          if (event.sequence <= contiguous) continue;
          pending.set(event.sequence, event);

          while (true) {
            const next = takeNextContiguousEvent(pending, contiguous);
            if (next === undefined) break;
            let chat = chats.get(next.chatGuid);
            if (chat === undefined) {
              chat = await client.chats.get(next.chatGuid);
              chats.set(next.chatGuid, chat);
            }
            const conversationKey = `conversation:${phone}:${next.chatGuid}`;
            if (!(next.type === "message.received" && next.message.isFromMe)) {
              const rawBody = deliveryFor(next, phone, chat);
              const source =
                next.type === "message.received" ? "webhook" : "advanced";
              const providerEventId =
                next.type === "message.received"
                  ? next.message.guid
                  : `${phone}:${next.type}:${next.sequence}`;
              await runApp(
                enqueueIMessageIngress({
                  source,
                  providerEventId,
                  phone,
                  conversationKey,
                  providerSequence: next.sequence,
                  rawBody,
                }),
              );
              // Always wake the partition. If a prior request inserted the
              // row but failed before starting Workflow, the duplicate replay
              // must still recover that durable event.
              await start(
                imessageIngressWorkflow,
                [conversationKey, randomUUID()],
                { deploymentId: "latest" },
              );
            }
            if (
              next.type === "poll.changed" &&
              next.delta.type === "voted" &&
              next.actor?.address !== undefined
            ) {
              const vote = await runApp(
                recordIMessagePollVote({
                  providerMessageId: next.pollMessageGuid,
                  participant: next.actor.address,
                  providerOptionId: next.delta.optionIdentifier,
                }),
              );
              if (vote.kind === "owner") {
                await start(
                  imessageInteractionResumeWorkflow,
                  [vote.interactionId, randomUUID()],
                  { deploymentId: "latest" },
                );
              }
            }
            contiguous = next.sequence;
            const advanced = await runApp(
              advanceIMessageProviderCursor({
                phone,
                eventStream: EVENT_STREAM,
                workerId,
                sequence: contiguous,
                ...(catchupHead === null
                  ? {}
                  : { catchupResult: `head:${catchupHead}` }),
              }),
            );
            if (!advanced) {
              throw new Error("Advanced iMessage cursor lease was lost");
            }
          }
        }
      } finally {
        await Promise.allSettled(streams.map((stream) => stream.close()));
        await catchup.close();
        queue.close();
        await Promise.allSettled(producers);
      }
    });
  } finally {
    await runApp(
      releaseIMessageProviderLease({ phone, eventStream: EVENT_STREAM, workerId }),
    );
  }

  return {
    status: "complete",
    advancedTo: contiguous,
    catchupHead,
    gap:
      catchupHead !== null && catchupHead > contiguous
        ? contiguous + 1
        : null,
  };
}
