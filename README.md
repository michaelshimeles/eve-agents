# eve-agents

A personal AI agent ("Eve") built with the [eve framework](https://eve.dev), served through a Next.js web chat and Telegram. Turborepo monorepo with the agent app in `apps/eve`.

## What it does

- **Web chat** — Next.js app with threads (rename/pin/delete/search), slash commands, file attachments, and streaming responses. Thread metadata lives in Neon Postgres.
- **Telegram channel** — private-DM-only bot with an allowlist (`TELEGRAM_ALLOWED_USER_IDS`).
- **Long-term memory** — Supermemory-backed `remember` / `forget` / `search_memory` / `list_memories` tools, with a profile summary injected each turn.
- **Receipt tracking** — `log_receipt` / `query_receipts` / `spending_summary` tools backed by Neon.
- **Chat-created skills** — the agent can write, list, and delete its own skills at runtime (`create_skill` / `delete_skill`).
- **Browser control** — sandboxed browser extension for web tasks.
- **App integrations** — Composio connection for third-party apps, plus small utility tools (weather, dice).

## Structure

```
apps/eve/
  agent/        # eve agent: channels, tools, skills, instructions, extensions
  app/          # Next.js web chat UI + API routes (threads, commands)
  components/   # UI components
  lib/          # threads DB (Neon), web auth
```

The Next.js app mounts the agent on the same origin via `withEve` — `/eve/v1/**` routes to the agent service. One dev server, one Vercel deployment.

## Getting started

Requires Node 24.

```bash
npm install
npm run dev   # turbo runs next dev for apps/eve on localhost:3000
```

`next dev` automatically boots the eve agent backend and proxies to it. Wait for `[eve:dev] server listening at ...` before chatting.

### Environment

Set these in `apps/eve/.env.local` (and the Vercel project for production):

| Variable | Used for |
| --- | --- |
| `DATABASE_URL` | Neon Postgres (threads, receipts) |
| `SUPERMEMORY_API_KEY` | Long-term memory |
| `COMPOSIO_API_KEY` | App integrations |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN` | Telegram channel |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated allowlist of Telegram user ids |

## Scripts

- `npm run dev` — dev server (web + agent)
- `npm run build` — production build
- `npm run typecheck` — TypeScript checks

## Deploy

Deployed to Vercel; the agent service is bundled into the same deployment and routed under `/eve/v1/**`.
