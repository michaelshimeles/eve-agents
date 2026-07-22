import { db } from "./receipts-db";

// Run history for proactive automations. Every reminder fire and webhook
// event appends a row here, so the management panel can show what actually
// happened (and link to the web chat thread it produced) instead of just
// "next fire" times and counters.

export interface AutomationRun {
  id: number;
  kind: "reminder" | "webhook";
  automation_id: string;
  fired_at: string;
  status: "ok" | "error";
  error: string | null;
  thread_id: string | null;
}

const PROJECTION = `
  id,
  kind,
  automation_id,
  fired_at::text AS fired_at,
  status,
  error,
  thread_id
`;

let ensured = false;

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await db().query(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id bigserial PRIMARY KEY,
      kind text NOT NULL,
      automation_id text NOT NULL,
      fired_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL,
      error text,
      thread_id text
    )
  `);
  await db().query(`
    CREATE INDEX IF NOT EXISTS automation_runs_by_automation
      ON automation_runs (kind, automation_id, fired_at DESC)
  `);
  ensured = true;
}

export async function recordAutomationRun(run: {
  kind: AutomationRun["kind"];
  automationId: string | number;
  status: AutomationRun["status"];
  error?: string;
  threadId?: string;
}): Promise<void> {
  await ensureTable();
  await db().query(
    `INSERT INTO automation_runs (kind, automation_id, status, error, thread_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [run.kind, String(run.automationId), run.status, run.error ?? null, run.threadId ?? null],
  );
}

/** Most recent runs across all automations, newest first. */
export async function listRecentRuns(limit = 200): Promise<AutomationRun[]> {
  await ensureTable();
  const rows = await db().query(
    `SELECT ${PROJECTION} FROM automation_runs ORDER BY fired_at DESC LIMIT $1`,
    [limit],
  );
  return rows as AutomationRun[];
}
