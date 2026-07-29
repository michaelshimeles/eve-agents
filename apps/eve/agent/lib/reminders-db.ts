import { CronExpressionParser } from "cron-parser";

import { db } from "./neon";

// Application-managed reminders/schedules, following eve's dynamic-scheduling
// pattern: rows live in Neon, CRUD tools manage them, and one authored
// minute-level schedule claims due rows and hands each to the Telegram
// channel as a proactive session. A one-off reminder has cron = null and is
// marked done after it fires; a recurring one advances next_fire_at from its
// cron expression (evaluated in its stored IANA timezone).

export const DEFAULT_TIMEZONE = "America/Toronto";

export interface ReminderRow {
  id: number;
  prompt: string;
  cron: string | null;
  timezone: string;
  next_fire_at: string;
  chat_id: string | null;
  status: string;
  created_at: string;
  last_fired_at: string | null;
}

const PROJECTION = `
  id,
  prompt,
  cron,
  timezone,
  next_fire_at::text AS next_fire_at,
  chat_id,
  status,
  created_at::text AS created_at,
  last_fired_at::text AS last_fired_at
`;

let ensured = false;

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await db().query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id serial PRIMARY KEY,
      prompt text NOT NULL,
      cron text,
      timezone text NOT NULL,
      next_fire_at timestamptz NOT NULL,
      chat_id text,
      status text NOT NULL DEFAULT 'active',
      claimed_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_fired_at timestamptz
    )
  `);
  ensured = true;
}

/** Next occurrence strictly after `after`. Throws on an invalid expression. */
export function nextCronOccurrence(cron: string, timezone: string, after = new Date()): Date {
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: after }).next().toDate();
}

export async function createReminder(input: {
  prompt: string;
  cron: string | null;
  timezone: string;
  nextFireAt: Date;
  chatId: string | null;
}): Promise<ReminderRow> {
  await ensureTable();
  const rows = await db().query(
    `INSERT INTO reminders (prompt, cron, timezone, next_fire_at, chat_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PROJECTION}`,
    [input.prompt, input.cron, input.timezone, input.nextFireAt.toISOString(), input.chatId],
  );
  return rows[0] as ReminderRow;
}

export async function listReminders(): Promise<ReminderRow[]> {
  await ensureTable();
  const rows = await db().query(
    `SELECT ${PROJECTION} FROM reminders WHERE status = 'active' ORDER BY next_fire_at ASC`,
  );
  return rows as ReminderRow[];
}

export async function cancelReminder(id: number): Promise<ReminderRow | null> {
  await ensureTable();
  const rows = await db().query(
    `UPDATE reminders SET status = 'cancelled', claimed_until = NULL
     WHERE id = $1 AND status = 'active'
     RETURNING ${PROJECTION}`,
    [id],
  );
  return (rows[0] as ReminderRow | undefined) ?? null;
}

/**
 * Atomically claim due reminders. The lease keeps a crashed dispatcher run
 * from stranding a row forever: an unfinished claim expires and the row is
 * picked up again on a later tick.
 */
export async function claimDueReminders(limit = 10, leaseMinutes = 5): Promise<ReminderRow[]> {
  await ensureTable();
  const rows = await db().query(
    `UPDATE reminders
     SET claimed_until = now() + make_interval(mins => $1)
     WHERE id IN (
       SELECT id FROM reminders
       WHERE status = 'active'
         AND next_fire_at <= now()
         AND (claimed_until IS NULL OR claimed_until < now())
       ORDER BY next_fire_at ASC
       LIMIT $2
     )
     RETURNING ${PROJECTION}`,
    [leaseMinutes, limit],
  );
  return rows as ReminderRow[];
}

/** Mark a claimed reminder delivered: done for one-offs, advanced for cron. */
export async function completeReminder(reminder: ReminderRow): Promise<void> {
  if (reminder.cron === null) {
    await db().query(
      `UPDATE reminders
       SET status = 'done', last_fired_at = now(), claimed_until = NULL
       WHERE id = $1`,
      [reminder.id],
    );
    return;
  }
  const next = nextCronOccurrence(reminder.cron, reminder.timezone);
  await db().query(
    `UPDATE reminders
     SET next_fire_at = $1, last_fired_at = now(), claimed_until = NULL
     WHERE id = $2`,
    [next.toISOString(), reminder.id],
  );
}

/** Release a claim after a delivery failure so a later tick retries it. */
export async function releaseReminder(id: number): Promise<void> {
  await db().query(`UPDATE reminders SET claimed_until = NULL WHERE id = $1`, [id]);
}
