import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Lazy init: eve evaluates authored modules at build time, where DATABASE_URL
// may be absent. Shared by the legacy async stores and the Effect Db layer
// (agent/lib/effect/db.ts) so both sides use one client.
let _sql: NeonQueryFunction<false, false> | null = null;

export function db(): NeonQueryFunction<false, false> {
  if (_sql === null) _sql = neon(process.env.DATABASE_URL!);
  return _sql;
}
