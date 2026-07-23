---
name: testing-eve-web
description: Run and test the Eve web chat app (apps/eve) end-to-end locally — dev server setup, Vercel env, sending messages, model selector, and Eve session API smoke tests. Use when verifying UI or agent-behavior changes in apps/eve.
---

# Testing the Eve web chat (apps/eve)

## Setup
1. Deps: `npm install` at the repo root.
2. Env: the app needs Vercel-provided env (Neon `DATABASE_URL`, Blob, OIDC for sandboxes). Pull it from the correct project (root directory is `apps/eve`):
   ```bash
   cd apps/eve
   npx vercel link --yes --project personal-agent --scope ${SENTRY_ORG} --token "$VERCEL_TOKEN"
   npx vercel env pull .env.local --yes --token "$VERCEL_TOKEN"
   ```
3. Dev server (detached, survives shell exit — plain `nohup` may not):
   ```bash
   cd apps/eve && setsid nohup npm run dev > /tmp/dev.log 2>&1 < /dev/null &
   ```
   App at http://localhost:3000. Check `/tmp/dev.log` for OIDC/DB errors; if OIDC expired, re-run `vercel env pull`.
4. Typecheck: `cd apps/eve && npm run typecheck`.

## Smoke-testing agent behavior via the Eve session API
`/eve/v1/**` is served on the same origin: `withEve` (next.config.ts) mounts the
agent service into the Next.js dev server. It only 404s while the embedded agent
backend is still booting — wait for `[eve:dev] server listening` in `/tmp/dev.log`
before curling:
```bash
until curl -sf localhost:3000/eve/v1/health >/dev/null; do sleep 2; done
```
Canonical routes (there is NO `/eve/v1/message`):
```bash
# start a session (returns sessionId)
curl -s -X POST localhost:3000/eve/v1/session -H 'content-type: application/json' \
  -d '{"message":"Reply with only: pong","clientContext":{"eveWebModel":"openai/gpt-5.2"}}'
# stream the reply
curl -sN localhost:3000/eve/v1/session/<sessionId>/stream | grep -m1 message.completed
```
The channel delivers `clientContext` as a user message `Client context:\n<json>`; the agent's dynamic model resolver in `agent/agent.ts` parses that exact shape.

## Latency profiling (per-turn overhead vs model TTFT)
- Time the event stream to split app overhead from model latency: record wall-clock deltas for `session.started`, `turn.started`, `message.received`, `step.started`, first `message.appended`, `message.completed`. The `turn.started → message.received` gap is pre-model context work (dynamic instructions/skills); expect ≤ ~0.3s. Multi-second gaps usually mean an external call or sandbox open on the turn path.
- To find slow outbound calls, temporarily monkey-patch `globalThis.fetch` in an agent-side module to log URL+duration (remove before committing). Watch `/tmp/dev.log` for `vercel.com/api/v2/sandboxes` calls — any during a plain chat turn means something (e.g. dynamic skills materialization) is forcing a sandbox open per turn.
- Follow-up turns: POST `localhost:3000/eve/v1/session/<sessionId>` with `{"message":"...","continuationToken":"<from session create>"}`, then re-read the same `/stream` (events carry `sequence`).

## Model selector testing tips
- The picker button is in the composer (bottom-left). Catalog comes from `/api/models` (Vercel AI Gateway); selection persists in localStorage `eve-web-model`, favorites in `eve-web-model-favorites`.
- Adversarial model-switch check: select a non-default model and ask "Which AI model are you? Answer with only the model family name (e.g. Claude, GPT, Gemini)." The default (claude-sonnet-5) answers "Claude"; a working switch to a GPT model answers "GPT".
- Clear localStorage keys to test the default path.

## Pitfalls
- The Vercel project root directory must be `apps/eve`; a wrong root breaks ${PUBLIC_SENTRY_ENVIRONMENT} deploys and env pulls.
- Sandbox tool calls may 403 if OIDC creds are stale — re-pull env and restart the dev server.
- `pkill -f "next dev"` can kill your own shell command; prefer targeting the PID from `/tmp/dev.log`/`lsof -i :3000`.
- CSS `group-hover` reveal-on-hover controls may not be capturable in automated screenshots; prefer always-visible controls or verify via DOM state.
- If the dev log loops on `waiting for sandbox template prewarm to finish`, stale template locks from killed processes may be blocking it: stop the server, delete `apps/eve/.eve/sandbox-cache/template-locks/<backend>/*.lock`, restart. A cold sandbox template build (npm install of agent-browser + chromium in the VM) can take several minutes — chat turns that don't need the sandbox should still work during prewarm.
- `lsof` may be unavailable; use `ss -ltnp`/`pgrep -fl node` instead to find the dev-server process.

## Devin Secrets Needed
- `VERCEL_TOKEN` — for `vercel link` / `vercel env pull` against the ${SENTRY_ORG} scope.
