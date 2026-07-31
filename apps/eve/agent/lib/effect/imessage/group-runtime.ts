import { gateway, generateText } from "ai";
import { Effect } from "effect";

import { getDefaultModelId } from "../../gateway-models";
import { type DatabaseError, Db } from "../db";
import { IMessageError } from "../imessage";

export const GROUP_NO_REPLY_TOKEN = "[no-reply]";

export interface SafeGroupTurn {
  readonly conversationKey: string;
  readonly senderRole: "owner" | "participant";
  readonly text: string;
  readonly attachmentNames: readonly string[];
}

export function safeGroupInstructions(): string {
  return `
You are Ruth, a helpful participant in an iMessage group chat.

This is a deliberately isolated public-group runtime. You have no tools, no
private owner profile, no direct-message history, no saved private skills, and
no access to files, email, cards, settings, reminders, browsers, networks, or
other agents. Never claim otherwise. You may use only the explicitly supplied
public history from this same group.

Every participant can read your answer. Answer harmless questions and help
with planning or coordination. Never reveal
or infer private information about the owner. Requests to spend money, contact
people, change settings, use a computer, administer the group, share location,
or take any externally visible action must be declined and referred to an
authenticated owner flow.

Do not respond to chatter that is not directed at you and would not benefit
from your participation. In that case answer with exactly ${GROUP_NO_REPLY_TOKEN}.
Otherwise write a concise iMessage-style response. CommonMark emphasis and
links are allowed, but do not use tables.
  `.trim();
}

export function normalizeSafeGroupReply(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === GROUP_NO_REPLY_TOKEN) return null;
  return trimmed;
}

const GROUP_HISTORY_LIMIT = 40;
const GROUP_HISTORY_MAX_CHARS = 12_000;

const ensureGroupMemoryTable = Effect.gen(function* () {
  const database = yield* Db;
  yield* database.query(
    `CREATE TABLE IF NOT EXISTS imessage_group_memory (
       id bigserial PRIMARY KEY,
       conversation_key text NOT NULL,
       role text NOT NULL,
       content text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  yield* database.query(
    `CREATE INDEX IF NOT EXISTS imessage_group_memory_recent_idx
       ON imessage_group_memory (conversation_key, created_at DESC, id DESC)`,
  );
});

export function clearSafeGroupMemory(
  conversationKey: string,
): Effect.Effect<void, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureGroupMemoryTable;
    yield* database.query(
      `DELETE FROM imessage_group_memory WHERE conversation_key = $1`,
      [conversationKey],
    );
  });
}

export function cleanupSafeGroupMemory(): Effect.Effect<void, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureGroupMemoryTable;
    yield* database.query(
      `DELETE FROM imessage_group_memory
        WHERE created_at < now() - interval '30 days'`,
    );
  });
}

function groupHistory(
  conversationKey: string,
): Effect.Effect<readonly { readonly role: string; readonly content: string }[], DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureGroupMemoryTable;
    yield* database.query(
      `DELETE FROM imessage_group_memory
        WHERE created_at < now() - interval '30 days'`,
    );
    const rows = yield* database.query(
      `SELECT role, content
         FROM imessage_group_memory
        WHERE conversation_key = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [conversationKey, GROUP_HISTORY_LIMIT],
    );
    return rows
      .reverse()
      .map((row) => ({
        role: typeof row.role === "string" ? row.role : "participant",
        content: typeof row.content === "string" ? row.content : "",
      }))
      .filter((row) => row.content.length > 0);
  });
}

function appendGroupMemory(input: {
  readonly conversationKey: string;
  readonly role: "owner" | "participant" | "ruth";
  readonly content: string;
}): Effect.Effect<void, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* database.query(
      `INSERT INTO imessage_group_memory (conversation_key, role, content)
       VALUES ($1, $2, $3)`,
      [input.conversationKey, input.role, input.content.slice(0, 16_000)],
    );
    yield* database.query(
      `DELETE FROM imessage_group_memory
        WHERE conversation_key = $1
          AND id NOT IN (
            SELECT id FROM imessage_group_memory
             WHERE conversation_key = $1
             ORDER BY created_at DESC, id DESC
             LIMIT 80
          )`,
      [input.conversationKey],
    );
  });
}

export function generateSafeGroupReply(
  input: SafeGroupTurn,
): Effect.Effect<string | null, IMessageError | DatabaseError, Db> {
  return Effect.gen(function* () {
    const history = yield* groupHistory(input.conversationKey);
    yield* appendGroupMemory({
      conversationKey: input.conversationKey,
      role: input.senderRole,
      content: input.text,
    });
    const publicHistory = history
      .map((entry) => `${entry.role}: ${entry.content}`)
      .join("\n")
      .slice(-GROUP_HISTORY_MAX_CHARS);
    const reply = yield* Effect.tryPromise({
      try: async () => {
      const attachmentNote =
        input.attachmentNames.length === 0
          ? ""
          : `\nAttachments visible to the channel adapter but not this text-only group runtime: ${input.attachmentNames.join(", ")}. Be honest that you cannot inspect them here.`;
      const result = await generateText({
        model: gateway(await getDefaultModelId()),
          system: safeGroupInstructions(),
          prompt: `${
            publicHistory.length === 0
              ? ""
              : `Public history from this group only:\n${publicHistory}\n\n`
          }Current message from the ${input.senderRole}:\n${input.text}${attachmentNote}`,
      });
      return normalizeSafeGroupReply(result.text);
      },
      catch: (cause) =>
        new IMessageError({
          reason: "spectrum",
          detail: `isolated group response failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        }),
    });
    if (reply !== null) {
      yield* appendGroupMemory({
        conversationKey: input.conversationKey,
        role: "ruth",
        content: reply,
      });
    }
    return reply;
  });
}
