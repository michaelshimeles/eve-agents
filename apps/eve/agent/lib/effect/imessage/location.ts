import { createHash, randomUUID } from "node:crypto";

import type { SharedFriendLocation } from "@photon-ai/advanced-imessage/grpc";
import { Effect } from "effect";

import { type DatabaseError, Db } from "../db";
import {
  decryptProviderIdentifier,
  encryptProviderIdentifier,
} from "./store";

function hashAddress(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex");
}

const ensureLocationTable = Effect.gen(function* () {
  const database = yield* Db;
  yield* database.query(
     `CREATE TABLE IF NOT EXISTS imessage_location_watch (
       watch_id uuid PRIMARY KEY,
       command_id text NOT NULL UNIQUE,
       owner_deployment text NOT NULL DEFAULT '',
       conversation_key text NOT NULL DEFAULT '',
       address_hash text NOT NULL,
       encrypted_snapshot text,
       status text NOT NULL DEFAULT 'active',
       watch_expires_at timestamptz NOT NULL,
       snapshot_expires_at timestamptz,
       source_sequence bigint NOT NULL DEFAULT -1,
       lease_holder text,
       lease_expires_at timestamptz,
       workflow_started_at timestamptz,
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  yield* database.query(
    `ALTER TABLE imessage_location_watch
       ADD COLUMN IF NOT EXISTS workflow_started_at timestamptz,
       ADD COLUMN IF NOT EXISTS owner_deployment text NOT NULL DEFAULT '',
       ADD COLUMN IF NOT EXISTS conversation_key text NOT NULL DEFAULT '',
       ADD COLUMN IF NOT EXISTS source_sequence bigint NOT NULL DEFAULT -1,
       ADD COLUMN IF NOT EXISTS lease_holder text,
       ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz`,
  );
});

export function beginIMessageLocationWatch(input: {
  readonly commandId: string;
  readonly ownerDeployment: string;
  readonly conversationKey: string;
  readonly address: string;
  readonly durationSeconds: number;
}): Effect.Effect<
  {
    readonly watchId: string;
    readonly created: boolean;
    readonly workflowStarted: boolean;
    readonly expiresAt: string;
  },
  DatabaseError,
  Db
> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    const watchId = randomUUID();
    const duration = Math.min(15 * 60, Math.max(30, Math.floor(input.durationSeconds)));
    const rows = yield* database.query(
      `INSERT INTO imessage_location_watch
         (watch_id, command_id, owner_deployment, conversation_key,
          address_hash, watch_expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 second'))
       ON CONFLICT (command_id) DO NOTHING
       RETURNING watch_id::text AS watch_id,
                 watch_expires_at::text AS watch_expires_at`,
      [
        watchId,
        input.commandId,
        input.ownerDeployment,
        input.conversationKey,
        hashAddress(input.address),
        duration,
      ],
    );
    const row = rows[0];
    if (row !== undefined) {
      return {
        watchId: String(row.watch_id),
        created: true,
        workflowStarted: false,
        expiresAt: String(row.watch_expires_at),
      };
    }
    const existing = yield* database.query(
      `SELECT watch_id::text AS watch_id, workflow_started_at IS NOT NULL AS workflow_started,
              watch_expires_at::text AS watch_expires_at
         FROM imessage_location_watch WHERE command_id = $1`,
      [input.commandId],
    );
    return {
      watchId: String(existing[0]?.watch_id ?? ""),
      created: false,
      workflowStarted: existing[0]?.workflow_started === true,
      expiresAt: String(existing[0]?.watch_expires_at ?? ""),
    };
  });
}

export function markIMessageLocationWorkflowStarted(
  watchId: string,
): Effect.Effect<void, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    yield* database.query(
      `UPDATE imessage_location_watch
          SET workflow_started_at = coalesce(workflow_started_at, now()),
              updated_at = now()
        WHERE watch_id = $1`,
      [watchId],
    );
  });
}

export function persistIMessageLocationSnapshot(input: {
  readonly watchId: string;
  readonly location: SharedFriendLocation;
  readonly sourceSequence?: number;
}): Effect.Effect<void, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    // Provider identifiers, coordinates, labels, and timestamps are encrypted
    // as one opaque value. Operational tables and logs see only the watch id.
    const encrypted = encryptProviderIdentifier(
      JSON.stringify({
        latitude: input.location.latitude,
        longitude: input.location.longitude,
        accuracy: input.location.accuracy,
        shortAddress: input.location.shortAddress,
        longAddress: input.location.longAddress,
        locationType: input.location.locationType,
        locationTimestamp: input.location.locationTimestamp?.toISOString(),
        isLocatingInProgress: input.location.isLocatingInProgress,
      }),
    );
    yield* database.query(
      `UPDATE imessage_location_watch
          SET encrypted_snapshot = $2,
              source_sequence = $3,
              snapshot_expires_at = LEAST(
                watch_expires_at,
                now() + interval '15 minutes'
              ),
              updated_at = now()
        WHERE watch_id = $1 AND status = 'active'
          AND watch_expires_at > now()
          AND ($3::bigint = -1 OR source_sequence <= $3::bigint)`,
      [input.watchId, encrypted, input.sourceSequence ?? -1],
    );
  });
}

export function acquireIMessageLocationWatchLease(input: {
  readonly watchId: string;
  readonly workerId: string;
}): Effect.Effect<boolean, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    const rows = yield* database.query(
      `UPDATE imessage_location_watch
          SET lease_holder = $2,
              lease_expires_at = now() + interval '240 seconds',
              updated_at = now()
        WHERE watch_id = $1
          AND status = 'active'
          AND watch_expires_at > now()
          AND (
            lease_expires_at IS NULL
            OR lease_expires_at <= now()
            OR lease_holder = $2
          )
        RETURNING watch_id`,
      [input.watchId, input.workerId],
    );
    return rows.length > 0;
  });
}

export function isIMessageLocationWatchActive(
  watchId: string,
): Effect.Effect<boolean, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    const rows = yield* database.query(
      `SELECT 1
         FROM imessage_location_watch
        WHERE watch_id = $1
          AND status = 'active'
          AND watch_expires_at > now()`,
      [watchId],
    );
    return rows.length > 0;
  });
}

export function finishIMessageLocationWatch(
  watchId: string,
  workerId?: string,
): Effect.Effect<void, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    yield* database.query(
      `UPDATE imessage_location_watch
          SET status = 'stopped',
              encrypted_snapshot = NULL,
              snapshot_expires_at = NULL,
              updated_at = now()
        WHERE watch_id = $1
          AND ($2::text IS NULL OR lease_holder = $2)`,
      [watchId, workerId ?? null],
    );
  });
}

export function listActiveIMessageLocationWatches(
  ownerDeployment: string,
): Effect.Effect<
  readonly {
    readonly watchId: string;
    readonly expiresAt: string;
    readonly hasSnapshot: boolean;
  }[],
  DatabaseError,
  Db
> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    const rows = yield* database.query(
      `SELECT watch_id::text AS watch_id,
              watch_expires_at::text AS watch_expires_at,
              encrypted_snapshot IS NOT NULL
                AND snapshot_expires_at > now() AS has_snapshot
         FROM imessage_location_watch
        WHERE owner_deployment = $1
          AND status = 'active'
          AND watch_expires_at > now()
        ORDER BY watch_expires_at`,
      [ownerDeployment],
    );
    return rows.map((row) => ({
      watchId: String(row.watch_id),
      expiresAt: String(row.watch_expires_at),
      hasSnapshot: row.has_snapshot === true,
    }));
  });
}

export function stopIMessageLocationWatch(input: {
  readonly watchId: string;
  readonly ownerDeployment: string;
}): Effect.Effect<boolean, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    const rows = yield* database.query(
      `UPDATE imessage_location_watch
          SET status = 'stopped',
              encrypted_snapshot = NULL,
              snapshot_expires_at = NULL,
              updated_at = now()
        WHERE watch_id = $1
          AND owner_deployment = $2
          AND status = 'active'
        RETURNING watch_id`,
      [input.watchId, input.ownerDeployment],
    );
    return rows.length > 0;
  });
}

export function cleanupIMessageLocationRetention(): Effect.Effect<
  void,
  DatabaseError,
  Db
> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    yield* database.query(
      `UPDATE imessage_location_watch
          SET status = 'stopped',
              encrypted_snapshot = NULL,
              snapshot_expires_at = NULL,
              updated_at = now()
        WHERE watch_expires_at <= now()
           OR (snapshot_expires_at IS NOT NULL AND snapshot_expires_at <= now())`,
    );
    yield* database.query(
      `DELETE FROM imessage_location_watch
        WHERE status = 'stopped' AND updated_at < now() - interval '7 days'`,
    );
  });
}

export function readIMessageLocationSnapshot(
  watchId: string,
): Effect.Effect<unknown | null, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    const rows = yield* database.query(
      `SELECT encrypted_snapshot
         FROM imessage_location_watch
        WHERE watch_id = $1 AND status = 'active'
          AND watch_expires_at > now()
          AND snapshot_expires_at > now()`,
      [watchId],
    );
    const encrypted = rows[0]?.encrypted_snapshot;
    if (typeof encrypted !== "string") return null;
    return JSON.parse(decryptProviderIdentifier(encrypted)) as unknown;
  });
}

export function readLatestIMessageLocationSnapshot(input: {
  readonly ownerDeployment: string;
  readonly conversationKey: string;
}): Effect.Effect<
  { readonly watchId: string; readonly snapshot: unknown } | null,
  DatabaseError,
  Db
> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLocationTable;
    const rows = yield* database.query(
      `SELECT watch_id::text AS watch_id, encrypted_snapshot
         FROM imessage_location_watch
        WHERE owner_deployment = $1
          AND conversation_key = $2
          AND status = 'active'
          AND watch_expires_at > now()
          AND snapshot_expires_at > now()
        ORDER BY updated_at DESC
        LIMIT 1`,
      [input.ownerDeployment, input.conversationKey],
    );
    const encrypted = rows[0]?.encrypted_snapshot;
    if (typeof encrypted !== "string") return null;
    return {
      watchId: String(rows[0]?.watch_id ?? ""),
      snapshot: JSON.parse(decryptProviderIdentifier(encrypted)) as unknown,
    };
  });
}
