# eveclaw

A personal AI assistant ("Eve") in the spirit of OpenClaw — proactive, always-on, and reachable from the web or Telegram. Built on the durable [eve framework](https://eve.dev) with a Next.js chat UI styled with Cloudflare's Kumo design system. Turborepo monorepo with the app in `apps/eve`.

## What it does

**Chat**

- **Web chat** — threads (rename/pin/delete), streaming responses, file attachments, slash-command prompts, model picker, and HTML artifact previews.
- **Command palette (⌘K)** — jump to threads, start a new chat, open the manage page, toggle notifications.
- **Full-text search** — sidebar search matches message content across all threads, not just titles.
- **Message actions** — copy a reply, edit & resend, regenerate the last reply, or fork a thread from any message.
- **Telegram channel** — private-DM-only bot with a user-id allowlist.

**Proactive**

- **Reminders & schedules** — ask Eve for one-off or recurring (cron) reminders; they fire into a new thread.
- **Event triggers** — Eve can mint webhook URLs so external services can start conversations.
- **Push notifications** — browser web-push for proactive threads, plus unread indicators in the sidebar.

**Agent capabilities**

- **Long-term memory** — Supermemory-backed remember/forget/search tools with nightly consolidation and a profile summary injected each turn.
- **App integrations** — Composio connections (Gmail, GitHub, Notion, Linear, …) with a UI to connect/disconnect apps.
- **Chat-created skills** — Eve can write, list, and delete her own skills at runtime; manage them from the UI.
- **File sharing** — Eve uploads sandbox files to Blob storage and hands back a public link.
- **Receipt tracking** — log/query/summarize spending, backed by Neon.
- **Browser control** — sandboxed browser extension for web tasks.

**Manage page** — `/manage` shows reminders (with run history), webhooks, memories, connections, and skills in one place.

## Structure

```
apps/eve/
  agent/        # eve agent: channels, tools, skills, schedules, instructions
  app/          # Next.js web chat UI + API routes (threads, search, automations)
  components/   # UI components (Kumo design system)
  lib/          # Neon-backed stores (threads, push), Composio connect, web auth
```

The Next.js app mounts the agent on the same origin via `withEve` — `/eve/v1/**` routes to the agent service. One dev server, one Vercel deployment.

## Getting started

Requires Node 24.

```bash
npm install
cp apps/eve/.env.example apps/eve/.env.local   # then fill in values
npm run dev   # turbo runs next dev for apps/eve on localhost:3000
```

`next dev` automatically boots the eve agent backend and proxies to it. Wait for `[eve:dev] server listening at ...` before chatting.

### Environment

See [`apps/eve/.env.example`](apps/eve/.env.example) for the full annotated list. The essentials:

| Variable | Used for |
| --- | --- |
| `EVE_WEB_USERNAME`, `EVE_WEB_PASSWORD` | HTTP Basic auth for the API routes in production |
| `DATABASE_URL` | Neon Postgres (threads, reminders, webhooks, receipts, push) |
| `SUPERMEMORY_API_KEY` | Long-term memory |
| `COMPOSIO_API_KEY` | App integrations |
| `BLOB_READ_WRITE_TOKEN` | File sharing + skill store |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web push notifications |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS` | Telegram channel (optional) |

## Scripts

- `npm run dev` — dev server (web + agent)
- `npm run build` — production build
- `npm run typecheck` — TypeScript checks

## Deploy

Deployed to Vercel; the agent service is bundled into the same deployment and routed under `/eve/v1/**`.
