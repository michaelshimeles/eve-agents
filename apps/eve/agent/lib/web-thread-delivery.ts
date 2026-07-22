import { Client, type HandleMessageStreamEvent } from "eve/client";

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

/** Runs `message` as a fresh session and persists it as a new web chat thread. */
export async function deliverToWebChatThread(title: string, message: string): Promise<void> {
  const client = new Client({ host: baseUrl() });
  const session = client.session();

  const response = await session.send({ message });
  const events: HandleMessageStreamEvent[] = [];
  for await (const event of response) events.push(event);

  await upsertThread(
    crypto.randomUUID(),
    {
      title: clipTitle(title),
      updatedAt: Date.now(),
      pinned: false,
      // Keeps the UI's auto-titling from overwriting the descriptive title.
      renamed: true,
    },
    { events, session: session.state },
  );
}
