import type { SlackApiResponse, SlackEvent } from "eve/channels/slack";

// Pure parsing of inbound Slack payloads, kept out of agent/channels/slack.ts
// so that file stays the thin declarative glue AGENTS.md asks for — and so
// this logic can be exercised on its own, which matters most for the thread
// anchor below.
//
// Every import here is type-only, so nothing in this module pulls the eve
// runtime in.

/** What a reaction lookup could recover about the reacted message. */
export interface ResolvedReaction {
  /** The reacted message's text, or null when it could not be read. */
  text: string | null;
  /** Author's Slack user id, when the message had one. */
  user: string | null;
  /**
   * The thread's root ts, or null when it could not be determined.
   *
   * Never the reacted message's own ts unless that message *is* the root: a
   * reply's ts is not a valid thread anchor, and posting against one lands the
   * reply under the wrong thread.
   */
  threadTs: string | null;
}

export const UNRESOLVED: ResolvedReaction = { text: null, user: null, threadTs: null };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Pulls the reacted message and its thread root out of a
 * `conversations.replies` response.
 *
 * `conversations.replies` is used rather than `conversations.history` because
 * it accepts either a thread parent's ts or a reply's ts, so it resolves a
 * reaction on a threaded reply too — `conversations.history` only ever returns
 * top-level messages and would silently miss those. Slack returns the thread
 * parent first, which is what keeps the root recoverable even when the reacted
 * reply itself falls outside the fetched page.
 */
export function resolveReaction(response: SlackApiResponse, ts: string): ResolvedReaction {
  const messages = response.messages;
  if (!Array.isArray(messages)) return UNRESOLVED;
  const records = messages.map(asRecord).filter((record) => record !== null);
  if (records.length === 0) return UNRESOLVED;

  // The parent is first; it is the root of every message in this response.
  const rootTs = str(records[0], "thread_ts") ?? str(records[0], "ts");

  const reacted = records.find((record) => record.ts === ts);
  if (reacted === undefined) {
    // Reacted reply is past the fetched page. The root still holds, so the
    // turn lands in the right thread with the text called out as unavailable.
    return { text: null, user: null, threadTs: rootTs };
  }
  return {
    text: str(reacted, "text"),
    user: str(reacted, "user"),
    // A root message carries no thread_ts; its own ts is the anchor.
    threadTs: str(reacted, "thread_ts") ?? str(reacted, "ts") ?? rootTs,
  };
}

/** The `item` of a `reaction_added` event, when it points at a message. */
export function reactedMessageRef(event: SlackEvent): { channelId: string; ts: string } | null {
  const record = asRecord(event.item);
  if (record === null) return null;
  // Reactions also land on files and file comments; only messages are handled.
  if (record.type !== "message") return null;
  const channelId = str(record, "channel");
  const ts = str(record, "ts");
  if (channelId === null || ts === null) return null;
  return { channelId, ts };
}

/**
 * Slack channel ids encode their conversation kind in the first character:
 * D is an IM. Inbound messages carry an authoritative `channel_type`, but a
 * reaction event does not, so the id is the only signal available there.
 */
export function isDirectMessageChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

/**
 * Message text with Slack's mention tokens (`<@U123>`) removed, so a command
 * survives being addressed — "@Ruth /new" has to read as "/new".
 */
export function commandText(text: string): string {
  return text.replace(/<@[^>]+>/g, " ").trim();
}
