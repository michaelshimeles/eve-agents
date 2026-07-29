# eve Agent App

This project uses the eve framework. Before writing code, read the relevant guide
from the installed eve package docs. In most installs, those docs are at
`node_modules/eve/docs/`. In workspaces or local package installs, resolve the
installed `eve` package location first and read its `docs/` directory. If
package docs are unavailable, use https://eve.dev/docs as a fallback.

## Effect (server-side code standard)

Part of the backend is [Effect](https://effect.website) **v4** code — the
sections below state exactly which parts. `effect` is pinned to an exact
`4.0.0-beta.x` version in `package.json`; keep the exact pin (no `^`), and
write v4 idioms (`Context.Service` keys, `Schema.to*` interop) — not Effect v3
ones.

Effect runs *inside* two boundaries that stay plain async TypeScript: the eve
framework contract (`defineTool` / `defineSchedule` / `defineChannel` exports)
and Next.js route handlers. Programs are executed at those boundaries through
one shared runtime.

### Structure

- `agent/lib/effect/runtime.ts` — composition root. Wire every service layer
  into `AppLayer` here. `runTool(effect)` runs a program at an eve tool
  boundary and renders typed failures as one-line model-readable errors.
- `agent/lib/effect/db.ts` — `Db` service over the shared Neon client with
  typed `DatabaseError`. All new SQL goes through this service.
- `agent/lib/effect/<domain>.ts` — one file per domain;
  `agent/lib/effect/receipts.ts` is the reference implementation. Each defines:
  Effect Schema structs as the single source of truth (service types,
  model-facing tool input schema, and row decoding), a `Context.Service`
  class, a `Layer.effect` live layer, and accessor functions returning
  `Effect` values.
- `agent/lib/effect/tool-schema.ts` — `toolSchema(...)` adapts an Effect Schema
  for eve's `inputSchema` (Standard Schema validate + draft-07 JSON Schema).
  Use it instead of zod for any tool whose logic runs on Effect.

### Conventions

- Failures are tagged errors (`Data.TaggedError`) in the error channel; never
  throw from inside a service. Only the boundary helper (`runTool`) converts
  failures into thrown `Error`s.
- Decode rows coming back from SQL with `Schema.decodeUnknownEffect` — parse,
  don't trust.
- Optional-with-default tool fields use `Schema.withDecodingDefaultKey`
  (matches zod `.default()`; plain `withDecodingDefault` admits null/undefined
  into the model-facing JSON Schema).
- Tools stay thin: `defineTool` + `toolSchema(InputSchema)` + a one-line
  `execute` calling `runTool(accessor(input))`. Domain logic lives in the
  service, not the tool file.

### Parts that must be written in Effect

When creating or substantially modifying code in these areas, write it on the
Effect stack (migrate what you touch; pure drive-by conversions are optional):

- **Neon-backed stores** — `agent/lib/reminders-db.ts`, `webhooks-db.ts`,
  `settings-db.ts`, `runs-db.ts`, `email-db.ts`, and `lib/threads-db.ts`,
  `lib/push-db.ts`. Receipts is already done (`agent/lib/effect/receipts.ts`).
- **External HTTP clients** — `agent/lib/agentmail.ts`, `agent/lib/orgo.ts`,
  `agent/lib/memory-store.ts`, `agent/lib/skill-store.ts`. Use
  `Effect.timeout` / `Effect.retry` / `Cache` policies rather than the
  hand-rolled `agent/lib/with-timeout.ts` and `agent/lib/swr-cache.ts`
  (those two are legacy and disappear as their callers migrate).
- **Tool implementations** in `agent/tools/` — the four receipt tools
  (`log_receipt`, `query_receipts`, `spending_summary`, `delete_receipt`) are
  the pattern to copy.
- **Schedule bodies** in `agent/schedules/` — orchestration as one Effect
  program (fan-out via `Effect.forEach` with bounded concurrency), run at the
  `defineSchedule` boundary.
- **API route handler logic** in `app/api/**` — an Effect program per route,
  run at the handler boundary.

### Parts that stay plain TypeScript

- **React UI** — `app/**/*.tsx`, `components/**`, and client hooks
  (`components/use-push.ts`). Effect is not used client-side.
- **eve boundary/config files** — `agent/agent.ts`, `agent/channels/*`,
  `agent/instructions/*`, `agent/sandbox.ts`, `agent/extensions/*`:
  declarative eve glue. Keep them thin and call into Effect-based libs for any
  real logic.
- **`agent/lib/neon.ts`** — the shared lazy Neon client used by both the
  legacy stores and the Effect `Db` layer for the duration of the migration.
- **Not-yet-migrated legacy stores** — they keep working as plain async
  TypeScript until their subsystem is migrated; don't half-convert one.
