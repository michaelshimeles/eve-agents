import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Lazy init: DATABASE_URL may be absent at build time (same pattern as
// agent/lib/neon.ts).
let _sql: NeonQueryFunction<false, false> | null = null;
let ensured: Promise<void> | null = null;

function sql(): NeonQueryFunction<false, false> {
  if (_sql === null) _sql = neon(process.env.DATABASE_URL!);
  return _sql;
}

async function ensureTable(): Promise<void> {
  ensured ??= (async () => {
    await sql()`
      CREATE TABLE IF NOT EXISTS web_chat_threads (
        id text PRIMARY KEY,
        title text NOT NULL,
        updated_at bigint NOT NULL,
        chat jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `;
    await sql()`
      ALTER TABLE web_chat_threads
        ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false
    `;
    await sql()`
      ALTER TABLE web_chat_threads
        ADD COLUMN IF NOT EXISTS renamed boolean NOT NULL DEFAULT false
    `;
    await sql()`
      ALTER TABLE web_chat_threads
        ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'web'
    `;
  })();
  await ensured;
}

/**
 * Who started the thread: the user, a fired reminder, a webhook event, or mail
 * arriving in the agent's own inbox.
 */
export type ThreadOrigin = "web" | "reminder" | "webhook" | "email";

export interface ThreadMetaRow {
  title: string;
  updatedAt: number;
  pinned: boolean;
  renamed: boolean;
  origin?: ThreadOrigin;
}

export interface ThreadRow extends ThreadMetaRow {
  id: string;
}

function toOrigin(value: unknown): ThreadOrigin {
  return value === "reminder" || value === "webhook" || value === "email" ? value : "web";
}

export async function listThreads(): Promise<ThreadRow[]> {
  await ensureTable();
  const rows = await sql()`
    SELECT id, title, updated_at, pinned, renamed, origin
    FROM web_chat_threads ORDER BY updated_at DESC
  `;
  return rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    updatedAt: Number(row.updated_at),
    pinned: Boolean(row.pinned),
    renamed: Boolean(row.renamed),
    origin: toOrigin(row.origin),
  }));
}

export interface ThreadSearchResult {
  id: string;
  title: string;
  updatedAt: number;
  /** Short excerpt around the first message-content match, if any. */
  snippet: string | null;
}

/**
 * Case-insensitive full-text search over thread titles and message content.
 * Message text is extracted from the persisted event log (user messages ride
 * in `message.received`, assistant replies in `message.completed`), so this
 * is a scan — fine at personal-assistant thread counts.
 */
export async function searchThreads(query: string, limit: number): Promise<ThreadSearchResult[]> {
  await ensureTable();
  const escaped = query.replace(/[%_\\]/g, (char) => `\\${char}`);
  const pattern = `%${escaped}%`;
  const rows = await sql()`
    SELECT id, title, updated_at, body FROM (
      SELECT id, title, updated_at,
        coalesce(
          (SELECT string_agg(event->'data'->>'message', E'\n')
             FROM jsonb_array_elements(chat->'events') AS event
            WHERE event->>'type' IN ('message.received', 'message.completed')),
          ''
        ) AS body
      FROM web_chat_threads
    ) AS threads
    WHERE title ILIKE ${pattern} OR body ILIKE ${pattern}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
  const needle = query.toLowerCase();
  return rows.map((row) => {
    const body = row.body as string;
    const at = body.toLowerCase().indexOf(needle);
    let snippet: string | null = null;
    if (at >= 0) {
      const start = Math.max(0, at - 40);
      const end = Math.min(body.length, at + needle.length + 60);
      snippet =
        `${start > 0 ? "…" : ""}${body.slice(start, end).replaceAll("\n", " ").trim()}` +
        `${end < body.length ? "…" : ""}`;
    }
    return {
      id: row.id as string,
      title: row.title as string,
      updatedAt: Number(row.updated_at),
      snippet,
    };
  });
}

/** Returns the stored chat payload, or null when the thread doesn't exist. */
export async function getThreadChat(id: string): Promise<unknown | null> {
  await ensureTable();
  const rows = await sql()`SELECT chat FROM web_chat_threads WHERE id = ${id}`;
  return rows.length > 0 ? rows[0].chat : null;
}

// Origin is written once on insert and never updated: rename/pin/chat writes
// from the UI must not reset a reminder/webhook thread back to "web".
//
// The update is conditional on the incoming event log being at least as long
// as the stored one. A thread's event log only ever grows (eve sessions are
// append-only and the client always writes the full log), so length is a
// writer-clock-independent version: a delayed retry, a slower tab, or a
// device with a skewed clock can never clobber a longer transcript with a
// shorter one, no matter what timestamp it carries. Equal lengths still
// apply, keeping retries and meta-refresh writes idempotent.
export async function upsertThread(
  id: string,
  meta: ThreadMetaRow,
  chat: unknown,
): Promise<void> {
  await ensureTable();
  await sql()`
    INSERT INTO web_chat_threads (id, title, updated_at, pinned, renamed, origin, chat)
    VALUES (${id}, ${meta.title}, ${meta.updatedAt}, ${meta.pinned}, ${meta.renamed},
            ${meta.origin ?? "web"}, ${JSON.stringify(chat)}::jsonb)
    ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title,
          updated_at = EXCLUDED.updated_at,
          pinned = EXCLUDED.pinned,
          renamed = EXCLUDED.renamed,
          chat = EXCLUDED.chat
      WHERE jsonb_array_length(coalesce(web_chat_threads.chat->'events', '[]'::jsonb))
         <= jsonb_array_length(coalesce(EXCLUDED.chat->'events', '[]'::jsonb))
  `;
}

/** Updates thread metadata (rename, pin) without touching the chat payload. */
export async function upsertThreadMeta(id: string, meta: ThreadMetaRow): Promise<void> {
  await ensureTable();
  await sql()`
    INSERT INTO web_chat_threads (id, title, updated_at, pinned, renamed, origin)
    VALUES (${id}, ${meta.title}, ${meta.updatedAt}, ${meta.pinned}, ${meta.renamed},
            ${meta.origin ?? "web"})
    ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title,
          updated_at = EXCLUDED.updated_at,
          pinned = EXCLUDED.pinned,
          renamed = EXCLUDED.renamed
  `;
}

export async function deleteThread(id: string): Promise<void> {
  await ensureTable();
  await sql()`DELETE FROM web_chat_threads WHERE id = ${id}`;
}
