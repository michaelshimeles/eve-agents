import { createHash } from "node:crypto";

import { Context, Effect, Layer, Schema } from "effect";
import type { SchemaError } from "effect/SchemaError";

import { type DatabaseError, Db } from "./db";

const MINUTE_LIMIT = 20;
const DAY_LIMIT = 500;
const LOCAL_CALLER_LIMIT = 10_000;

const WindowKind = Schema.Literals(["minute", "day"]);
const RateLimitRow = Schema.Struct({
  window_kind: WindowKind,
  request_count: Schema.Int,
  max_requests: Schema.Int,
  retry_after_seconds: Schema.Int,
});
type RateLimitRow = typeof RateLimitRow.Type;

export interface AnonymousEveRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export type AnonymousEveRateLimitError = DatabaseError | SchemaError;

export class AnonymousEveRateLimit extends Context.Service<
  AnonymousEveRateLimit,
  {
    readonly check: (
      callerHash: string,
    ) => Effect.Effect<AnonymousEveRateLimitDecision, AnonymousEveRateLimitError>;
  }
>()("AnonymousEveRateLimit") {}

/**
 * Durable, cross-session request accounting for the public Eve HTTP channel.
 * The table is initialized lazily so deployments that only use authenticated
 * channels do not need a database merely to construct the shared runtime.
 */
export const AnonymousEveRateLimitLive = Layer.effect(
  AnonymousEveRateLimit,
  Effect.gen(function* () {
    const database = yield* Db;
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(RateLimitRow));
    const localWindows = new Map<
      string,
      {
        dayCount: number;
        dayStartedAt: number;
        minuteCount: number;
        minuteStartedAt: number;
      }
    >();
    let initialized = false;

    const checkLocal = (callerHash: string): AnonymousEveRateLimitDecision => {
      const now = Date.now();
      const minuteStartedAt = Math.floor(now / 60_000) * 60_000;
      const dayStartedAt = Math.floor(now / 86_400_000) * 86_400_000;
      const previous = localWindows.get(callerHash);
      if (previous !== undefined) {
        localWindows.delete(callerHash);
      } else if (localWindows.size >= LOCAL_CALLER_LIMIT) {
        const oldestCaller = localWindows.keys().next().value;
        if (oldestCaller !== undefined) localWindows.delete(oldestCaller);
      }
      const next = {
        minuteStartedAt,
        minuteCount:
          previous?.minuteStartedAt === minuteStartedAt ? previous.minuteCount + 1 : 1,
        dayStartedAt,
        dayCount: previous?.dayStartedAt === dayStartedAt ? previous.dayCount + 1 : 1,
      };
      localWindows.set(callerHash, next);
      const minuteRetry =
        next.minuteCount > MINUTE_LIMIT
          ? Math.max(1, Math.ceil((minuteStartedAt + 60_000 - now) / 1000))
          : 0;
      const dayRetry =
        next.dayCount > DAY_LIMIT
          ? Math.max(1, Math.ceil((dayStartedAt + 86_400_000 - now) / 1000))
          : 0;
      return {
        allowed: minuteRetry === 0 && dayRetry === 0,
        retryAfterSeconds: Math.max(minuteRetry, dayRetry),
      };
    };

    const ensureTable = Effect.gen(function* () {
      if (initialized) return;
      yield* database.transaction([
        {
          sql: `
            CREATE TABLE IF NOT EXISTS anonymous_eve_rate_limits (
              caller_hash text NOT NULL,
              window_kind text NOT NULL CHECK (window_kind IN ('minute', 'day')),
              window_started_at timestamptz NOT NULL,
              request_count integer NOT NULL CHECK (request_count > 0),
              PRIMARY KEY (caller_hash, window_kind, window_started_at)
            )
          `,
        },
        {
          sql: `
            CREATE INDEX IF NOT EXISTS anonymous_eve_rate_limits_expiry_idx
            ON anonymous_eve_rate_limits (window_started_at)
          `,
        },
      ]);
      initialized = true;
    });

    return {
      check: (callerHash) =>
        (process.env.DATABASE_URL ?? "").trim().length === 0
          ? Effect.succeed(checkLocal(callerHash))
          : Effect.gen(function* () {
              yield* ensureTable;
              const rows = yield* database.query(
                `
              WITH windows(window_kind, window_started_at, max_requests, window_seconds) AS (
                VALUES
                  ('minute'::text, date_trunc('minute', now()), $2::integer, 60::integer),
                  ('day'::text, date_trunc('day', now()), $3::integer, 86400::integer)
              ),
              pruned AS (
                DELETE FROM anonymous_eve_rate_limits
                WHERE window_started_at < now() - interval '2 days'
              ),
              upserted AS (
                INSERT INTO anonymous_eve_rate_limits (
                  caller_hash,
                  window_kind,
                  window_started_at,
                  request_count
                )
                SELECT $1, window_kind, window_started_at, 1
                FROM windows
                ON CONFLICT (caller_hash, window_kind, window_started_at)
                DO UPDATE SET request_count =
                  anonymous_eve_rate_limits.request_count + 1
                RETURNING window_kind, window_started_at, request_count
              )
              SELECT
                upserted.window_kind,
                upserted.request_count,
                windows.max_requests,
                greatest(
                  1,
                  ceil(extract(epoch FROM (
                    upserted.window_started_at
                    + windows.window_seconds * interval '1 second'
                    - now()
                  )))::integer
                ) AS retry_after_seconds
              FROM upserted
              JOIN windows USING (window_kind, window_started_at)
              ORDER BY upserted.window_kind
            `,
                [callerHash, MINUTE_LIMIT, DAY_LIMIT],
              );
              const decoded = yield* decodeRows(rows);
              const blocked = decoded.filter((row) => row.request_count > row.max_requests);
              return {
                allowed: blocked.length === 0,
                retryAfterSeconds: blocked.reduce(
                  (longest, row) => Math.max(longest, row.retry_after_seconds),
                  0,
                ),
              };
            }),
    };
  }),
);

/** Only message-creating POSTs consume the anonymous model-call budget. */
export function isAnonymousEveMessageRequest(request: Request): boolean {
  if (request.method !== "POST") return false;
  const pathname = new URL(request.url).pathname;
  if (pathname === "/eve/v1/session") return true;
  const match = /^\/eve\/v1\/session\/([^/]+)$/.exec(pathname);
  return match !== null && match[1] !== "reset";
}

/**
 * Hash the Vercel-authenticated client address so the durable limiter never
 * stores a raw IP. Missing addresses share one conservative fallback bucket.
 */
export function anonymousEveCallerHash(request: Request): string {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("x-forwarded-for") ??
    "unknown";
  const address = forwarded.split(",", 1)[0]?.trim() || "unknown";
  return createHash("sha256").update(`ruth:anonymous-eve:${address}`).digest("hex");
}

export const checkAnonymousEveRateLimit = (
  callerHash: string,
): Effect.Effect<
  AnonymousEveRateLimitDecision,
  AnonymousEveRateLimitError,
  AnonymousEveRateLimit
> =>
  Effect.gen(function* () {
    return yield* (yield* AnonymousEveRateLimit).check(callerHash);
  });
