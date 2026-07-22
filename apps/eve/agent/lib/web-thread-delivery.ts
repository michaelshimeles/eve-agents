import { Client, type HandleMessageStreamEvent } from "eve/client";

import { sendPushToAll } from "../../lib/push-db";
import { upsertThread } from "../../lib/threads-db";

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

/**
 * Runs `message` as a fresh session and persists it as a new web chat thread.
 * Returns the new thread's id so callers can link run history to it.
 */
export async function deliverToWebChatThread(
  title: string,
  message: string,
  origin: "reminder" | "webhook" = "reminder",
): Promise<string> {
  const client = new Client({ host: baseUrl() });
  const session = client.session();

  const response = await session.send({ message });
  const events: HandleMessageStreamEvent[] = [];
  for await (const event of response) events.push(event);

  const threadId = crypto.randomUUID();
  await upsertThread(
    threadId,
    {
      title: clipTitle(title),
      updatedAt: Date.now(),
      pinned: false,
      // Keeps the UI's auto-titling from overwriting the descriptive title.
      renamed: true,
      origin,
    },
    { events, session: session.state },
  );

  // Best-effort: the thread is already persisted, so a notification failure
  // must not fail the delivery — callers would retry the whole run and create
  // a duplicate thread (and webhook history would lose the thread link).
  try {
    await sendPushToAll({ title: "Eve", body: pushBody(events) ?? clipTitle(title) });
  } catch (error) {
    console.error("Proactive push notification failed:", error);
  }
  return threadId;
}

/** The agent's final reply, clipped for a notification body. */
function pushBody(events: readonly HandleMessageStreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "message.completed") continue;
    const message = (event.data as { message?: string | null }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      const oneLine = message.replaceAll("\n", " ").trim();
      return oneLine.length > 160 ? `${oneLine.slice(0, 160).trimEnd()}…` : oneLine;
    }
  }
  return null;
}
