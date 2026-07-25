import { db } from "./receipts-db";

// Bookkeeping for the agent's email account. Three jobs:
//
// 1. Claim each received message exactly once. The webhook and the polling
//    schedule both feed the same handler (and Svix retries on any non-2xx), so
//    the claim is what stops one email from waking the agent three times.
// 2. Remember the registered AgentMail webhook and its Svix signing secret, so
//    inbound works with just AGENTMAIL_API_KEY set - the schedule registers the
//    endpoint against the deployment's own URL and stores what it got back.
// 3. Remember the connected custom domain. Which domain the address should
//    live on is configuration, and AgentMail only knows what domains exist,
//    not which one this agent chose.

export interface InboundRow {
  message_id: string;
  thread_id: string;
  claimed_at: string;
  source: string;
  status: string;
  error: string | null;
  web_thread_id: string | null;
}

let ensured: Promise<void> | null = null;

async function ensureTables(): Promise<void> {
  ensured ??= (async () => {
    await db().query(`
      CREATE TABLE IF NOT EXISTS email_inbound (
        message_id text PRIMARY KEY,
        thread_id text NOT NULL,
        claimed_at timestamptz NOT NULL DEFAULT now(),
        source text NOT NULL,
        status text NOT NULL DEFAULT 'claimed',
        error text,
        web_thread_id text
      )
    `);
    await db().query(`
      CREATE TABLE IF NOT EXISTS email_webhook (
        client_id text PRIMARY KEY,
        webhook_id text NOT NULL,
        url text NOT NULL,
        secret text NOT NULL,
        registered_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Single row: a personal agent has one primary address, so one domain.
    await db().query(`
      CREATE TABLE IF NOT EXISTS email_domain (
        id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        domain text NOT NULL,
        domain_id text NOT NULL,
        connected_at timestamptz NOT NULL DEFAULT now(),
        verified_at timestamptz
      )
    `);
  })();
  await ensured;
}

/**
 * Takes ownership of a received message. Returns false when someone already
 * claimed it, which is the signal to drop the delivery as a duplicate.
 */
export async function claimInboundMessage(
  messageId: string,
  threadId: string,
  source: "webhook" | "poll" | "seed",
): Promise<boolean> {
  await ensureTables();
  const rows = await db().query(
    `INSERT INTO email_inbound (message_id, thread_id, source, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id`,
    [messageId, threadId, source, source === "seed" ? "seeded" : "claimed"],
  );
  return rows.length > 0;
}

export async function recordInboundResult(
  messageId: string,
  result: { status: "ok" | "error" | "skipped"; error?: string; webThreadId?: string },
): Promise<void> {
  await ensureTables();
  await db().query(
    `UPDATE email_inbound
        SET status = $2, error = $3, web_thread_id = $4
      WHERE message_id = $1`,
    [messageId, result.status, result.error ?? null, result.webThreadId ?? null],
  );
}

/** Releases a claim so the next poll retries a message whose handling failed. */
export async function releaseInboundClaim(messageId: string): Promise<void> {
  await ensureTables();
  await db().query(`DELETE FROM email_inbound WHERE message_id = $1`, [messageId]);
}

/** True before any inbound message has been seen, i.e. this deployment is new. */
export async function inboundLedgerIsEmpty(): Promise<boolean> {
  await ensureTables();
  const rows = await db().query(`SELECT 1 FROM email_inbound LIMIT 1`);
  return rows.length === 0;
}

/**
 * Which of `messageIds` are already claimed. The poll uses this to skip mail
 * that was seeded or already handled before spending its dispatch slots -
 * such mail stays visibly unread for the human, but must not be re-examined.
 */
export async function claimedMessageIds(messageIds: readonly string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  await ensureTables();
  const rows = await db().query(
    `SELECT message_id FROM email_inbound WHERE message_id = ANY($1::text[])`,
    [[...messageIds]],
  );
  return new Set(rows.map((row) => (row as { message_id: string }).message_id));
}

export interface WebhookRegistration {
  webhook_id: string;
  url: string;
  secret: string;
  registered_at: string;
}

export async function getWebhookRegistration(
  clientId: string,
): Promise<WebhookRegistration | null> {
  await ensureTables();
  const rows = await db().query(
    `SELECT webhook_id, url, secret, registered_at::text AS registered_at
       FROM email_webhook WHERE client_id = $1`,
    [clientId],
  );
  return (rows[0] as WebhookRegistration | undefined) ?? null;
}

export async function saveWebhookRegistration(
  clientId: string,
  registration: { webhookId: string; url: string; secret: string },
): Promise<void> {
  await ensureTables();
  await db().query(
    `INSERT INTO email_webhook (client_id, webhook_id, url, secret)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id) DO UPDATE
       SET webhook_id = EXCLUDED.webhook_id,
           url = EXCLUDED.url,
           secret = EXCLUDED.secret,
           registered_at = now()`,
    [clientId, registration.webhookId, registration.url, registration.secret],
  );
}

export interface ConnectedDomain {
  domain: string;
  domain_id: string;
  connected_at: string;
  /** Set once AgentMail reports the domain VERIFIED; the address moves then. */
  verified_at: string | null;
}

const DOMAIN_PROJECTION = `
  domain,
  domain_id,
  connected_at::text AS connected_at,
  verified_at::text AS verified_at
`;

export async function getConnectedDomain(): Promise<ConnectedDomain | null> {
  await ensureTables();
  const rows = await db().query(`SELECT ${DOMAIN_PROJECTION} FROM email_domain WHERE id = 1`);
  return (rows[0] as ConnectedDomain | undefined) ?? null;
}

export async function saveConnectedDomain(domain: string, domainId: string): Promise<void> {
  await ensureTables();
  await db().query(
    `INSERT INTO email_domain (id, domain, domain_id)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE
       SET domain = EXCLUDED.domain,
           domain_id = EXCLUDED.domain_id,
           connected_at = now(),
           verified_at = NULL`,
    [domain.toLowerCase(), domainId],
  );
}

export async function markDomainVerified(domain: string): Promise<void> {
  await ensureTables();
  await db().query(
    `UPDATE email_domain SET verified_at = now() WHERE id = 1 AND domain = $1`,
    [domain.toLowerCase()],
  );
}

export async function clearConnectedDomain(): Promise<void> {
  await ensureTables();
  await db().query(`DELETE FROM email_domain WHERE id = 1`);
}
