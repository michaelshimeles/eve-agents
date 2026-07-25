import { db } from "./receipts-db";
import { swrCache, type SwrCache } from "./swr-cache";

// App-managed settings, for the handful of values the owner can change from
// the UI instead of the deployment's environment (today: the Orgo API key).
// Values are stored as plaintext rows in Neon: encrypting them would only move
// the secret into a passphrase env var, and the database already holds the
// conversation transcripts, so it is the trust boundary either way.
//
// Reads are cached briefly because capability gating consults settings on
// every session start; writes invalidate so a just-saved key applies to the
// next session immediately.

const READ_TTL_MS = 30_000;

function hasDatabase(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

let ensured = false;

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await db().query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      name text PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  ensured = true;
}

const caches = new Map<string, SwrCache<string | null>>();

function cacheFor(name: string): SwrCache<string | null> {
  let cache = caches.get(name);
  if (cache === undefined) {
    cache = swrCache(READ_TTL_MS, async () => {
      await ensureTable();
      const rows = await db().query(`SELECT value FROM app_settings WHERE name = $1`, [name]);
      const value = (rows[0] as { value?: string } | undefined)?.value;
      return value === undefined || value.length === 0 ? null : value;
    });
    caches.set(name, cache);
  }
  return cache;
}

export const settingsStore = {
  /** Null when unset or when there is no database to hold settings at all. */
  async get(name: string): Promise<string | null> {
    if (!hasDatabase()) return null;
    try {
      return await cacheFor(name).get();
    } catch {
      // A database hiccup should read as "not configured", not take the app down.
      return null;
    }
  },

  async set(name: string, value: string): Promise<void> {
    if (!hasDatabase()) {
      throw new Error(
        "No database is configured, so app-managed settings cannot be saved. Set DATABASE_URL, or use an environment variable instead.",
      );
    }
    await ensureTable();
    await db().query(
      `INSERT INTO app_settings (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [name, value],
    );
    cacheFor(name).invalidate();
  },

  async delete(name: string): Promise<void> {
    if (!hasDatabase()) return;
    await ensureTable();
    await db().query(`DELETE FROM app_settings WHERE name = $1`, [name]);
    cacheFor(name).invalidate();
  },
};
