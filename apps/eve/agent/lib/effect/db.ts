import { Context, Data, Effect, Layer } from "effect";

import { db } from "../neon";

/** A SQL statement failed (connection, syntax, constraint, missing env). */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

export function describeDatabaseError(error: DatabaseError): string {
  const detail = error.cause instanceof Error ? error.cause.message : String(error.cause);
  return `Database query failed: ${detail}`;
}

export type DbRow = Record<string, unknown>;

export interface DbStatement {
  readonly sql: string;
  readonly params?: unknown[];
}

/**
 * Neon Postgres as an Effect service. Queries carry `DatabaseError` in the
 * typed error channel instead of throwing, so callers must decide how a
 * failure propagates.
 */
export class Db extends Context.Service<Db, {
  readonly query: (sql: string, params?: unknown[]) => Effect.Effect<DbRow[], DatabaseError>;
  readonly transaction: (
    statements: readonly DbStatement[],
  ) => Effect.Effect<readonly DbRow[][], DatabaseError>;
}>()("Db") {}

/** Production layer over the shared lazy Neon client (`agent/lib/neon.ts`). */
export const DbLive = Layer.sync(Db, () => ({
  query: (sql, params) =>
    Effect.tryPromise({
      try: () => db().query(sql, params),
      catch: (cause) => new DatabaseError({ cause }),
    }),
  transaction: (statements) =>
    Effect.tryPromise({
      try: () =>
        db()
          .transaction((transaction) =>
            statements.map(({ sql, params }) => transaction.query(sql, params)),
          )
          .then((results) => results as DbRow[][]),
      catch: (cause) => new DatabaseError({ cause }),
    }),
}));
