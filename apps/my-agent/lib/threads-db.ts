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
  ensured ??= sql()`
    CREATE TABLE IF NOT EXISTS web_chat_threads (
      id text PRIMARY KEY,
      title text NOT NULL,
      updated_at bigint NOT NULL,
      chat jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `.then(() => undefined);
  await ensured;
}

export interface ThreadRow {
  id: string;
  title: string;
  updatedAt: number;
}

export async function listThreads(): Promise<ThreadRow[]> {
  await ensureTable();
  const rows = await sql()`
    SELECT id, title, updated_at FROM web_chat_threads ORDER BY updated_at DESC
  `;
  return rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    updatedAt: Number(row.updated_at),
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
  title: string,
  updatedAt: number,
  chat: unknown,
): Promise<void> {
  await ensureTable();
  await sql()`
    INSERT INTO web_chat_threads (id, title, updated_at, chat)
    VALUES (${id}, ${title}, ${updatedAt}, ${JSON.stringify(chat)}::jsonb)
    ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title,
          updated_at = EXCLUDED.updated_at,
          chat = EXCLUDED.chat
  `;
}

export async function deleteThread(id: string): Promise<void> {
  await ensureTable();
  await sql()`DELETE FROM web_chat_threads WHERE id = ${id}`;
}
