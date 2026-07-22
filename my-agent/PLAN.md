# Upgrade plan: closing the OpenClaw gap

Four workstreams, in build order. Each phase is independently shippable and
verified before moving on. Skipped by decision: voice/audio, device presence
(camera/screen/local exec).

## Phase 1 — Supermemory (memory layer) — IMPLEMENTED

Done. Implementation notes where they differ from the original plan:
`remember` uses `POST /v4/memories` (direct memory creation, immediately
searchable, supports `isStatic` for permanent traits) instead of the async
`/v3/documents` pipeline. A `list_memories` tool was added so `forget` can
work off real document ids. Remaining manual steps:

1. Get an API key at console.supermemory.ai and add `SUPERMEMORY_API_KEY` to
   `.env.local` and the Vercel project env.
2. Run the migration: `node --env-file=.env.local scripts/migrate-memories.ts`
   (also sets the account filter prompt).
3. Verify in `eve dev`, then `eve deploy`.

Replace the flat JSON blob memory with Supermemory so recall scales and the
agent gets profile-style context instead of a full dump every turn.

**Env:** `SUPERMEMORY_API_KEY` (local `.env.local` + Vercel project env).

**Changes:**

- `agent/lib/memory-store.ts` — rewrite internals against the Supermemory API,
  keeping a store interface the tools consume:
  - add: `POST https://api.supermemory.ai/v3/documents` with
    `containerTag: "micky"`
  - search: `POST https://api.supermemory.ai/v4/search`
    (`searchMode: "hybrid"`)
  - profile: `POST https://api.supermemory.ai/v4/profile`
  - delete: documents delete endpoint by document id
- `agent/tools/remember.ts` / `agent/tools/forget.ts` — adapt to
  content-based memories (Supermemory ids replace our snake_case keys;
  `forget` deletes by id from a prior search/list).
- New `agent/tools/search_memory.ts` — explicit recall tool for questions
  about older context.
- `agent/instructions/memory.ts` — on `turn.started`, inject the profile
  summary (v4/profile) instead of the full memory list. Keep the "memory
  temporarily unavailable" fallback.
- One-off migration script: read `memory/memories.json` from Blob, POST each
  entry to Supermemory, verify count, then retire the blob.

**Verify:** `eve dev`, save a fact, restart, ask "what do you know about me";
confirm profile injection and search recall both work.

## Phase 2 — Proactivity (reminders + standing schedules)

One authored dispatcher schedule + a reminder store + CRUD tools, per eve's
dynamic-scheduling pattern. Telegram already supports proactive delivery via
`receive(telegram, { target: { chatId } })`.

**Env:** `MICKY_TELEGRAM_CHAT_ID` (default reminder destination; also
captured automatically from session context when he creates a reminder in
chat).

**Changes:**

- `agent/lib/reminder-store.ts` — Vercel Blob JSON store (same pattern as
  skill-store): rows `{ id, prompt, nextRunAt, everyMinutes | null, chatId,
  leaseUntil }`. `claimDue` sets a short lease so overlapping minute ticks
  can't double-fire; `complete` disables one-time rows or advances
  recurring ones.
- `agent/schedules/dispatch.ts` — `defineSchedule({ cron: "* * * * *", run })`:
  claim due rows, `receive(telegram, { message: row.prompt, target:
  { chatId } })` for each, `complete` on success, release with retry on
  failure. Wrap in `waitUntil`.
- `agent/schedules/morning-briefing.ts` — `run`-form schedule (NOT markdown
  task mode, whose output is discarded) at `0 11 * * *` UTC (07:00 Toronto)
  that hands a "prepare the morning briefing: calendar, inbox, weather"
  prompt to Telegram via `receive`.
- Tools: `agent/tools/create_reminder.ts` (ISO datetime with offset +
  optional `everyMinutes`), `list_reminders.ts`, `delete_reminder.ts`.
- `agent/instructions.md` — new section: "remind me to..." goes straight to
  create_reminder; always convert his local time to ISO with offset; confirm
  the scheduled time back in one short phrase.

**Notes:**

- Delivery is at-least-once; mark rows complete before heavy work and phrase
  side-effecting reminder prompts idempotently.
- Minute-level Vercel Cron requires a paid plan (Hobby crons are once daily).
  Confirm plan before deploy; fallback is a coarser dispatcher cadence.
- `eve dev` never fires crons — test via the schedule dispatch route.

**Verify:** create a reminder for two minutes out in dev, trigger dispatch,
confirm the Telegram message arrives and one-time rows disable themselves.

## Phase 3 — Browser control (agent-browser in the eve sandbox) — IMPLEMENTED

Done, more simply than planned: the official `@agent-browser/eve` extension
(mounted at `agent/extensions/browser.ts`) contributes ~20 `browser__` tools
plus its own instructions fragment, so no hand-written skill was needed.
`agent/sandbox.ts` pins the Vercel sandbox backend and pre-installs
agent-browser + Chromium into the template via `installAgentBrowser`. No new
env vars required. Original plan below for reference.

agent-browser's docs state fresh eve/Vercel sandboxes install Chromium system
dependencies by default, so the sandbox the agent already has can drive a
real browser. No new vendor to start.

**Changes:**

- `agent/sandbox/sandbox.ts` — `defineSandbox` with `bootstrap` installing
  agent-browser (`npm install -g agent-browser` + browser install step) so
  every session's template has it ready. Bump `revalidationKey` when
  changing setup.
- `agent/skills/browsing.md` — authored skill teaching the loop:
  `agent-browser open <url>` → `snapshot -i` → act on `@e` refs
  (`click`, `fill`, `type`) → re-snapshot; screenshot for visual checks;
  `close` when done. Warn: never enter credentials without asking first.
- `agent/instructions.md` — one line in Capabilities pointing at the skill.

**Later (optional):** Browserbase provider for persistent logged-in sessions
and recordings — set `AGENT_BROWSER_PROVIDER=browserbase`,
`BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`; commands are unchanged.

**Verify:** ask the agent to pull data from a JS-heavy page and to fill a
simple form (e.g. a search flow) end to end.

## Phase 4 — Channels via Chat SDK (Discord + iMessage)

Add `eve/channels/chat-sdk` with Discord and iMessage adapters. Keep the
existing first-class Telegram channel as-is — it works, supports proactive
sends (reminder delivery target), and consolidating buys nothing right now.

**Decisions needed before starting:**

- iMessage vendor: Photon (`@photon-ai/chat-adapter-imessage`; cloud,
  self-hosted, or on-device Mac), Sendblue, Linq, Blooio, or AgentPhone.
  All ride a relay — pick by pricing/setup preference.
- State store: Chat SDK needs a durable state adapter in production —
  `@chat-adapter/state-redis` + Upstash (or `state-pg`). In-memory is
  dev-only.

**Env:** Discord bot token/app credentials, iMessage vendor credentials,
`REDIS_URL` (or Postgres) for state.

**Changes:**

- Install `chat`, `@chat-adapter/discord`, chosen iMessage adapter,
  `@chat-adapter/state-redis`.
- `agent/channels/chatsdk.ts` — `chatSdkChannel({ adapters: { discord,
  imessage }, state, userName: "Eve" })`; handlers mirror the Telegram
  allowlist policy: DMs only, drop anything not from Micky's ids.
- Point provider webhooks at `/eve/v1/discord` and `/eve/v1/imessage`.
- `agent/instructions.md` — note the agent now lives on multiple surfaces;
  plain-text style rule stays (all three render markdown poorly or
  inconsistently in DMs).

**Verify:** DM round-trip on each surface; confirm a stranger's message is
ignored; confirm typing indicators degrade gracefully where unsupported.

## Cross-cutting

- After each phase: `npm run typecheck`, exercise in `eve dev`, then
  `eve deploy` and set the phase's env vars on Vercel.
- Order rationale: Supermemory first (small, self-contained, everything else
  benefits), proactivity second (highest-value gap), browser third (one file
  + one skill), channels last (most external moving pieces: vendor accounts,
  webhooks, state store).
