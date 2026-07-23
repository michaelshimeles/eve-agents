# eveclaw

A personal AI assistant ("Eve") in the spirit of OpenClaw — proactive, always-on, and reachable from the web or Telegram — plus a **builder** that deploys configured copies of her into anyone's Vercel account in one click. Built on the durable [eve framework](https://eve.dev) with a Next.js chat UI styled with Whop's [Frosted UI](https://github.com/whopio/frosted-ui) design system. Turborepo monorepo: the agent app lives in `apps/eve`, the agent builder in `apps/builder`.

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

**Agent builder (`apps/builder`)** — a wizard where anyone can configure their own Eve (name, personality, per-tool capabilities, channels, custom cron jobs, editable generated instructions) and one-click deploy it into **their** Vercel account:

- The template is the live `apps/eve` source — assembled at deploy time with feature pruning, so the personal agent and the product never drift. A manifest completeness check fails CI if a new tool isn't mapped to a feature.
- Deploys via the Vercel REST API with the user's token: create project → set env vars → deploy inline files → stream build status → health check. Keys pass through in memory and are never stored; VAPID push keys are generated automatically; models bill to the deployer's own AI Gateway (no provider keys).
- Telegram webhook registration happens automatically after deploy when a bot token is provided.

## Structure

```
apps/eve/         # the agent app (also the builder's deploy template)
  agent/          # eve agent: channels, tools, skills, schedules, instructions
  app/            # Next.js web chat UI + API routes (threads, search, automations)
  components/     # UI components (Frosted UI design system)
  lib/            # Neon-backed stores (threads, push), Composio connect, web auth
apps/builder/     # the eveclaw agent builder
  app/            # wizard UI + deploy API routes (identify, deploy, status, finalize)
  lib/            # Vercel API client, feature manifest, assembler, generators
  scripts/        # manifest completeness check, manual smoke deploy
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
| `DATABASE_URL` | Neon Postgres (threads, reminders, webhooks, receipts, push) |
| `SUPERMEMORY_API_KEY` | Long-term memory |
| `COMPOSIO_API_KEY` | App integrations |
| `BLOB_READ_WRITE_TOKEN` | File sharing + skill store |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web push notifications |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS` | Telegram channel (optional) |

## Scripts

- `npm run dev` — dev servers (agent app on :3000, builder on :3100)
- `npm run build` — production build
- `npm run typecheck` — TypeScript checks + builder manifest completeness
- `VERCEL_TOKEN=… DATABASE_URL=… npx tsx apps/builder/scripts/smoke-deploy.ts` — manual end-to-end deploy test (creates and deletes a real project)

## Deploy

Deployed to Vercel; the agent service is bundled into the same deployment and routed under `/eve/v1/**`.
