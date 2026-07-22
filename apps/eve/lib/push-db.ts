import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import webpush, { WebPushError, type PushSubscription } from "web-push";

// Web Push subscriptions for proactive notifications (fired reminders and
// webhooks landing as web chat threads). Browsers register through
// POST /api/push; deliverToWebChatThread fans a notification out to every
// stored subscription. Dead subscriptions (410/404 from the push service)
// are pruned on send.

let _sql: NeonQueryFunction<false, false> | null = null;
let ensured: Promise<void> | null = null;
let vapidConfigured = false;

function sql(): NeonQueryFunction<false, false> {
  if (_sql === null) _sql = neon(process.env.DATABASE_URL!);
  return _sql;
}

async function ensureTable(): Promise<void> {
  ensured ??= (async () => {
    await sql()`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint text PRIMARY KEY,
        subscription jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  })();
  await ensured;
}

function configureVapid(): boolean {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails("mailto:eve@localhost", publicKey, privateKey);
    vapidConfigured = true;
  }
  return true;
}

export async function saveSubscription(subscription: PushSubscription): Promise<void> {
  await ensureTable();
  await sql()`
    INSERT INTO push_subscriptions (endpoint, subscription)
    VALUES (${subscription.endpoint}, ${JSON.stringify(subscription)}::jsonb)
    ON CONFLICT (endpoint) DO UPDATE SET subscription = EXCLUDED.subscription
  `;
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  await ensureTable();
  await sql()`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
}

/** Sends a notification to every subscribed browser; prunes dead endpoints. */
export async function sendPushToAll(payload: { title: string; body: string }): Promise<void> {
  if (!configureVapid()) return;
  await ensureTable();
  const rows = await sql()`SELECT endpoint, subscription FROM push_subscriptions`;

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          row.subscription as PushSubscription,
          JSON.stringify(payload),
        );
      } catch (error) {
        if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
          await deleteSubscription(row.endpoint as string);
          return;
        }
        console.error("Push delivery failed:", error);
      }
    }),
  );
}
