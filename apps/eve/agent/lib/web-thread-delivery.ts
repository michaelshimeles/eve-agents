import { Client, type HandleMessageStreamEvent } from "eve/client";

import { sendPushToAll } from "../../lib/push-db";
import { upsertThread } from "../../lib/threads-db";
import { agentName } from "./owner";

// Delivers proactive work (fired reminders, webhook events) into the web chat
// UI. The chat UI renders threads from persisted eve stream events (SavedChat
// in app/chat.tsx), so we run the work as a real session against our own eve
// HTTP channel, collect its events, and insert them as a new thread row. The
// stored session state keeps the thread continuable: opening it and replying
// resumes the same session.

function baseUrl(): string {
  // Proactive work runs inside the deployed app, so the eve routes are our own host.
  const vercel = process.env.VERCEL_URL;
  if (vercel !== undefined && vercel.length > 0) return `https://${vercel}`;
  return `http://localhost:${process.env.PORT ?? "3000"}`;
}

function clipTitle(title: string): string {
  const oneLine = title.replaceAll("\n", " ").trim();
  return oneLine.length > 44 ? `${oneLine.slice(0, 44).trimEnd()}…` : oneLine;
}

export interface WebChatDelivery {
  threadId: string;
  /** The agent's final reply, for callers that mirror it into notifications. */
  reply: string | null;
}

/**
 * Runs `message` as a fresh session and persists it as a new web chat thread.
 * Returns the new thread's id so callers can link run history to it, plus the
 * agent's final reply so the result can be mirrored to other channels.
 */
export async function deliverToWebChatThread(
  title: string,
  message: string,
  origin: "reminder" | "webhook" | "email" = "reminder",
): Promise<WebChatDelivery> {
  const client = new Client({ host: baseUrl() });
  const session = client.session();

  const response = await session.send({ message });
  const events: HandleMessageStreamEvent[] = [];
  for await (const event of response) events.push(event);

  const threadId = crypto.randomUUID();
  // savedAt matches updatedAt, like the web client's own writes, so the UI's
  // staleness check (savedAt vs meta.updatedAt) sees an adopted copy as
  // current instead of probing the server again on every visit.
  const writtenAt = Date.now();
  await upsertThread(
    threadId,
    {
      title: clipTitle(title),
      updatedAt: writtenAt,
      pinned: false,
      // Keeps the UI's auto-titling from overwriting the descriptive title.
      renamed: true,
      origin,
    },
    { events, session: session.state, savedAt: writtenAt },
  );

  const reply = finalReply(events);

  // Best-effort: the thread is already persisted, so a notification failure
  // must not fail the delivery — callers would retry the whole run and create
  // a duplicate thread (and webhook history would lose the thread link).
  try {
    await sendPushToAll({ title: agentName(), body: pushBody(reply) ?? clipTitle(title) });
  } catch (error) {
    console.error("Proactive push notification failed:", error);
  }
  return { threadId, reply };
}

/** The agent's final completed message, or null when the run produced none. */
function finalReply(events: readonly HandleMessageStreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "message.completed") continue;
    // Text the model emits before requesting a tool call also completes as a
    // message; only a terminal message is the reply (same rule as the
    // framework channels' message.completed handling).
    if (event.data.finishReason === "tool-calls") continue;
    const message = event.data.message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return null;
}

/** The reply as one line, clipped for a notification body. */
function pushBody(reply: string | null): string | null {
  if (reply === null) return null;
  const oneLine = reply.replaceAll("\n", " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160).trimEnd()}…` : oneLine;
}
