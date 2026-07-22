import { randomBytes } from "node:crypto";

import { db } from "./receipts-db";

// Agent-managed webhooks (event triggers): each row is an inbound HTTP
// endpoint with a stored instruction. The hooks channel
// (agent/channels/hooks.ts) receives POSTs at /eve/v1/hooks/:id/:secret,
// verifies the secret, and wakes the agent with the stored prompt plus the
// event payload. Delivery follows origin like reminders: Telegram-created
// hooks report into that DM, web-created ones land as web chat threads.

export interface WebhookRow {
  id: string;
  secret: string;
  name: string;
  prompt: string;
  chat_id: string | null;
  created_at: string;
  last_fired_at: string | null;
  fire_count: number;
}

const PROJECTION = `
  id,
  secret,
  name,
  prompt,
  chat_id,
  created_at::text AS created_at,
  last_fired_at::text AS last_fired_at,
  fire_count
`;

let ensured = false;

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await db().query(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id text PRIMARY KEY,
      secret text NOT NULL,
      name text NOT NULL,
      prompt text NOT NULL,
      chat_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_fired_at timestamptz,
      fire_count integer NOT NULL DEFAULT 0
    )
  `);
  ensured = true;
}

export async function createWebhook(input: {
  name: string;
  prompt: string;
  chatId: string | null;
}): Promise<WebhookRow> {
  await ensureTable();
  const id = `whk_${randomBytes(6).toString("hex")}`;
  const secret = randomBytes(24).toString("hex");
  const rows = await db().query(
    `INSERT INTO webhooks (id, secret, name, prompt, chat_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PROJECTION}`,
    [id, secret, input.name, input.prompt, input.chatId],
  );
  return rows[0] as WebhookRow;
}

export async function listWebhooks(): Promise<WebhookRow[]> {
  await ensureTable();
  const rows = await db().query(`SELECT ${PROJECTION} FROM webhooks ORDER BY created_at ASC`);
  return rows as WebhookRow[];
}

export async function getWebhook(id: string): Promise<WebhookRow | null> {
  await ensureTable();
  const rows = await db().query(`SELECT ${PROJECTION} FROM webhooks WHERE id = $1`, [id]);
  return (rows[0] as WebhookRow | undefined) ?? null;
}

export async function deleteWebhook(id: string): Promise<WebhookRow | null> {
  await ensureTable();
  const rows = await db().query(
    `DELETE FROM webhooks WHERE id = $1 RETURNING ${PROJECTION}`,
    [id],
  );
  return (rows[0] as WebhookRow | undefined) ?? null;
}

export async function recordWebhookFire(id: string): Promise<void> {
  await db().query(
    `UPDATE webhooks SET last_fired_at = now(), fire_count = fire_count + 1 WHERE id = $1`,
    [id],
  );
}

/** Public URL for a webhook. Prefers the stable production domain. */
export function webhookUrl(hook: Pick<WebhookRow, "id" | "secret">): string {
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL ?? null;
  const base = host !== null ? `https://${host}` : `http://localhost:${process.env.PORT ?? "3000"}`;
  return `${base}/eve/v1/hooks/${hook.id}/${hook.secret}`;
}
