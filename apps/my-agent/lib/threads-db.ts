import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Lazy init: DATABASE_URL may be absent at build time (same pattern as
// agent/lib/receipts-db.ts).
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
  })();
  await ensured;
}

export interface ThreadMetaRow {
  title: string;
  updatedAt: number;
  pinned: boolean;
  renamed: boolean;
}

export interface ThreadRow extends ThreadMetaRow {
  id: string;
}

export async function listThreads(): Promise<ThreadRow[]> {
  await ensureTable();
  const rows = await sql()`
    SELECT id, title, updated_at, pinned, renamed
    FROM web_chat_threads ORDER BY updated_at DESC
  `;
  return rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    updatedAt: Number(row.updated_at),
    pinned: Boolean(row.pinned),
    renamed: Boolean(row.renamed),
  }));
}

/** Returns the stored chat payload, or null when the thread doesn't exist. */
export async function getThreadChat(id: string): Promise<unknown | null> {
  await ensureTable();
  const rows = await sql()`SELECT chat FROM web_chat_threads WHERE id = ${id}`;
  return rows.length > 0 ? rows[0].chat : null;
}

export async function upsertThread(
  id: string,
  meta: ThreadMetaRow,
  chat: unknown,
): Promise<void> {
  await ensureTable();
  await sql()`
    INSERT INTO web_chat_threads (id, title, updated_at, pinned, renamed, chat)
    VALUES (${id}, ${meta.title}, ${meta.updatedAt}, ${meta.pinned}, ${meta.renamed},
            ${JSON.stringify(chat)}::jsonb)
    ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title,
          updated_at = EXCLUDED.updated_at,
          pinned = EXCLUDED.pinned,
          renamed = EXCLUDED.renamed,
          chat = EXCLUDED.chat
  `;
}

/** Updates thread metadata (rename, pin) without touching the chat payload. */
export async function upsertThreadMeta(id: string, meta: ThreadMetaRow): Promise<void> {
  await ensureTable();
  await sql()`
    INSERT INTO web_chat_threads (id, title, updated_at, pinned, renamed)
    VALUES (${id}, ${meta.title}, ${meta.updatedAt}, ${meta.pinned}, ${meta.renamed})
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
