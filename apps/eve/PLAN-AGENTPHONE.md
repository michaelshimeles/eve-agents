# Ruth's phone — AgentPhone integration plan

Give Ruth a real phone number: send and receive SMS/MMS/iMessage, make and
receive voice calls, and hold a verification inbox so she can complete 2FA on
accounts she owns.

Scope decision (confirmed): **full phone, coexisting with Spectrum.** The
existing shared-line iMessage router in `agent/lib/effect/imessage.ts` is not
touched. Nothing that works today regresses; the two channels run side by side
and the owner can move over when this is proven.

## What AgentPhone gives us

Dedicated US/CA number, $3/mo, Twilio-backed, from one REST API.

| Capability | Endpoint | Gate |
| --- | --- | --- |
| Send SMS/MMS/iMessage | `POST /v1/messages` | 10DLC for outbound **SMS to US numbers** only |
| Receive SMS/iMessage | `agent.message` webhook | none — works immediately |
| Receive calls | `agent.message` webhook, `channel: "voice"` | none |
| Make calls | `POST /v1/calls` | none |
| Verification inbox | `GET /v1/numbers/{id}/messages` | none |

Costs: $3/mo per number, $0.02/SMS each way, $0.13/min voice in webhook mode,
$0.22/min hosted, $25 one-time for 10DLC. **There is no sandbox or test mode** —
every call is production and bills real money. That single fact drives two
decisions below: a local stub is mandatory, and the first live checks are
scripted and minimal.

## The two hard problems

### 1. Live voice inside eve's async model — SOLVED

AgentPhone's voice webhook is synchronous: it expects newline-delimited JSON
written into the response body of the inbound request, within a configurable
5–120s budget (default 30s), and TTS starts speaking on the first chunk. eve's
channels, by contrast, all acknowledge the webhook and push replies out-of-band.

The primitive that reconciles them is already public and already used by eve's
own web chat:

- `send()` returns a `Session` immediately, without awaiting the turn
- `Session.getEventStream({ startIndex })` returns a live, durable, *tailing*
  stream of that session's events
- eve's built-in channel serves exactly this stream as
  `application/x-ndjson; charset=utf-8` — the same content type AgentPhone wants

So the voice route is a transform over eve's own event stream:

| eve event | AgentPhone chunk |
| --- | --- |
| `actions.requested` (nothing spoken yet) | `{"text":"One moment.","interim":true}` — kills dead air while tools run |
| `message.completed`, `finishReason === "tool-calls"` | `{"text":…,"interim":true}` — narration before a tool call |
| `message.completed`, terminal | `{"text":…}` — closes the turn |
| `turn.failed` | a spoken apology, then close |
| `turn.completed` / `session.waiting` | end the response |

Three caveats that shape the implementation:

- **The stream never ends on its own.** A parked session holds the readable open
  forever. Terminate on a boundary event; eve exports `isCurrentTurnBoundaryEvent`
  for precisely this.
- **`startIndex` addresses the session, not the turn.** Turn 2 of a call would
  replay turn 1 from `startIndex: 0`. We persist a per-call cursor
  (`agentphone_call` row keyed by `call_id`) and resume from it, capturing our
  turn's `turnId` from the first `turn.started` we see after our `send()`.
- **Budget.** We set the webhook `timeout` to its 120s maximum and still emit an
  interim chunk immediately, because Ruth's turns routinely run long (computer
  use, browser, email). On overrun, `session.cancel({ turnId })` stops the turn
  cooperatively and the session parks normally for the next utterance.

### 2. Official adapter vs. custom channel — for text

`@agentphone/chat-sdk-adapter` (v0.1.0) exists and is officially documented at
`eve.dev/integrations/chat-sdk-agentphone`, wired through `eve/channels/chat-sdk`.

We read its source (the sourcemap ships full `sourcesContent`, so the original
TypeScript is recoverable — the whole package is 4 files, ~470 lines). It has
**correctness bugs**, not just gaps:

- **`openDM` builds a thread id that can never match an inbound one.** It emits
  `agentphone:${agentId}:${phone}` — the agent id where a phone number belongs —
  while inbound threads are `agentphone:${ourNumber}:${theirNumber}`. Any
  conversation Ruth starts lives in a different thread from the reply.
- **Reaction events land on a phantom thread** for the same reason (`numberId`
  where the phone number belongs), so a tapback can never be correlated.
- **Live voice appears to work and isn't.** The adapter routes on `body.event`,
  not `channel`, so an in-call `agent.message` *does* reach the handler — but
  every webhook path returns a literal `200 "OK"`, and the reply goes out
  through `POST /v1/messages`. The caller hears silence while a stray SMS is
  sent. That is the worst possible failure mode.
- **`isMe: !isInbound` silently discards `agent.call_ended` for outbound and web
  calls**, so calls Ruth places produce nothing at all.
- **Silent truncation at 1600 chars** (`text.slice(0, 1600)`) — no segmentation,
  no error. Long replies get chopped mid-sentence.
- Raw markdown is sent verbatim, so recipients see literal `**bold**`.
- `files`/buffer uploads are silently dropped; only pre-hosted URLs work.
- `fetchMessages` returns `[]` forever and history is never persisted.
- No group modelling at all — `isDM()` is hardcoded `true`, so a group iMessage
  fragments into one 1:1 thread per sender.
- No `from_number` selection, so multi-number routing is impossible.
- **Webhook verification is skipped entirely when the secret is unset** — no
  warning, no error.
- `editMessage` throws, so streaming throws. No API escape hatch: it touches
  exactly two endpoints and `apiFetch` is private, so `/v1/numbers/{id}/messages`
  (2FA) and `POST /v1/calls` are unreachable through it.

Arguments against, specific to this repo:

- `apps/eve/AGENTS.md` is binding: new external HTTP clients and Neon-backed
  stores **must** be Effect v4; channels stay thin glue. The Chat SDK brings its
  own delivery, threading, and state layer that sits outside that.
- It needs a Chat SDK state adapter. `state-memory` is dev-only; production means
  `state-pg` (a second `pg` pool alongside `@neondatabase/serverless`) or
  `state-redis` (a Redis dependency this project doesn't have). Either is a
  second state store beside Neon.
- Streaming is post-then-edit, on by default (`streamingEditIntervalMs: 1000`).
  On SMS every edit is a separate billable message. Must be `streaming: false`.
- It cannot serve the live-voice contract — it returns 200 and delivers
  out-of-band. Voice needs the custom channel regardless.
- It has no equivalent of the machinery the iMessage channel earned the hard way:
  the claim/settle/release dedupe + burst-folding table, `attributes.role =
  "guest"` (which is what makes `agent/lib/owner-gate.ts` a *code-enforced*
  boundary on ~14 owner-only tools), capability-URL attachments, line pinning.
- `PLAN.md:124-138` proposed the chat-sdk route for iMessage originally; it was
  not taken, and the custom channel was built instead.

**Decided: custom `defineChannel`, mirroring the iMessage channel.** We already
need custom code for live voice, for `/v1/numbers/{id}/messages` and
`/v1/calls`, and for group threads — that is most of the surface. Adopting the
adapter would leave us hand-rolling all of it anyway while inheriting two
thread-id bugs, a truncation footgun, and a webhook path that is insecure by
default.

Worth keeping from it: the HMAC verification recipe (already ported in
`agent/lib/agentphone-signature.ts` — it matches the documented scheme exactly)
and the dual error-envelope parser.

A useful consequence: dropping the Chat SDK also drops its state adapter. No
second Postgres pool beside Neon, no `pg` dependency, no `-pooler` connection
string, no TTL sweeper cron — all of which `state-pg` would have required, since
it leaks expired cache/list rows and has no sweeper of its own.

## Architecture

```
agent/lib/agentphone-signature.ts     HMAC verify (sha256=<hex> over `<ts>.<body>`)   [done]
agent/lib/effect/agentphone.ts        Effect service: API client + Neon store
agent/channels/agentphone.ts          text: SMS / MMS / iMessage
agent/channels/agentphone-voice.ts    voice: the NDJSON bridge
agent/tools/agentphone.ts             dynamic: send_text, call_someone, verification_code
agent/instructions/agentphone.ts      dynamic instructions, gated on configured()
app/api/phone/route.ts                Manage → Phone (BYO key, provision, register)
components/phone-panel.tsx            the UI
scripts/agentphone-stub.mjs           local provider stub
```

Two channel files because the file stem is the channel id and the two surfaces
have genuinely different contracts (async ack vs. synchronous NDJSON). They share
the Effect service underneath.

### Effect service

Follows `agent/lib/effect/receipts.ts` (the reference implementation named by
AGENTS.md) and `agent/lib/effect/imessage.ts` (the closest analogue):

- `AgentPhoneError extends Data.TaggedError` with a `reason` union
  (`not_configured | no_database | validation | api | carrier | not_registered`)
  and an optional `status`, plus `describeAgentPhoneError` — registered in
  `runtime.ts`'s `describeFailure` chain, and `AgentPhoneLive` added to `AppLayer`.
- Raw `fetch` over the published SDK. The SDK's generated types are `unknown` for
  every call endpoint, it has no documented per-request header option (we need
  `X-Sub-Account-Id`), no SSE support, and no webhook-signature helper. We'd be
  writing all of that anyway.
- `Effect.timeout` / `Effect.retry` per AGENTS.md — **not** the legacy hand-rolled
  `with-timeout.ts` / `swr-cache.ts`.
- Key resolution copies the Orgo pattern exactly: `AGENTPHONE_API_KEY` from env,
  else a pasted key in the `app_settings` row `agentphone-api-key`; env always
  wins. `AGENTPHONE_API_BASE_URL` repoints to the stub.

**The API's casing is inconsistent and the client must encode that, not
normalize it away.** `/v1/messages*` and `/v1/register*` are snake_case;
everything else is camelCase; path and query params are always snake_case. The
reaction response disagrees between the OpenAPI spec and the guide, so it is read
defensively. This is documented at each call site rather than hidden behind a
converter, so a future reader can check a field against the spec.

### Tables

Lazy `CREATE TABLE IF NOT EXISTS` inside the layer, gated by a `tablesReady`
closure flag — the established pattern; there is no migration runner.

- `agentphone_config` — singleton row (`id integer PRIMARY KEY CHECK (id = 1)`):
  provisioned `number_id`, `phone_number`, `agent_id`, and the webhook `secret`.
  The secret must be persisted on write because `POST /v1/webhooks` mints a
  **new** one on every create *and* update.
- `agentphone_inbound` — `message_id` PK, the claim/settle/release table ported
  from `imessage_inbound`: dedupes the 6-attempt webhook retry schedule, folds
  rapid-fire texts into one turn, and reclaims rows stranded by a crash.
- `agentphone_call` — `call_id` PK, the per-call event-stream cursor plus
  conversation continuity across turns of one call.

### Security posture

Carried over from the iMessage channel deliberately, because a phone number is a
*public* inbound surface — anyone who learns it can text or call.

- Verify HMAC on raw bytes **before** parsing. 5-minute replay window,
  constant-time compare, dedupe on `X-Webhook-ID`.
- DM policy: only the owner's handle starts a session. Everyone else is accepted
  with a 200 (so retries stop) and dropped.
- Non-owner callers get `attributes.role = "guest"`, which inherits the entire
  `owner-gate.ts` approval policy for free. Its header comment asks for exactly
  this.
- **Caller ID is not an auth factor.** It is trivially spoofed, so a voice caller
  is a guest until proven otherwise, and no owner-only tool is reachable from an
  unverified call.
- Outbound texts and calls are irreversible and externally visible, so they carry
  `approval` and are described in the confirm-first style of `send_email.ts`.

### 2FA

The narrow, honest version: tools that read Ruth's own inbound SMS.
`GET /v1/numbers/{id}/messages` with a sender/recency filter, plus a webhook path
so an arriving code can wake a thread.

The limitation is real and worth stating in the tool description rather than
discovering later: these are Twilio numbers, and Google, Apple, WhatsApp, and
most banks run carrier lookups that reject non-mobile numbers at signup. This is
reliable for ordinary SaaS and unreliable for exactly the high-value accounts.
Scope it to accounts **Ruth** creates, not the owner's — otherwise the agent loop
becomes a path to the owner's account recovery.

## Build order

Each phase is independently shippable and verified before the next.

1. **Foundation** — signature module (done), Effect service + client + tables,
   `runtime.ts` wiring, env globs in `turbo.json` (both `build` and `dev`), stub.
2. **Verification inbox** — the 2FA tools. Smallest surface, no channel, real
   value immediately.
3. **Text channel** — inbound SMS/iMessage with claim/settle/debounce, outbound
   delivery, typing where supported, guest attribution.
4. **Voice** — the NDJSON bridge for inbound; `POST /v1/calls` for outbound, with
   hosted mode (`systemPrompt` per call) for scripted errands so simple calls
   skip the bridge entirely.
5. **Surface** — Manage → Phone (paste key, provision number, 10DLC status),
   feature flag, `delivery.ts` target, instructions.

## What has been verified

Against the stub, with a real dev server, real Neon, and real model turns:

| Path | Result |
| --- | --- |
| Signature round trip | 9/9 — accepts valid, rejects tampered body, wrong secret, missing headers, replay >5min, length mismatch |
| Channel discovery | both mounted, `/eve/v1/agentphone/inbound` and `/eve/v1/agentphone/voice`, no route collision |
| Provisioning | agent created, number bought, webhook registered, secret persisted, owner number normalized |
| Inbound text | signature → owner attribution → typing indicator → model turn → reply delivered |
| Outbound text | `send_text` reached the provider with the right body |
| Outbound call | `call_someone` reached the provider in scripted mode |
| **Live voice** | NDJSON streamed into the response body; 3 turns of one call held context ("Got it — 47" → "You said 47") |
| Interim chunks | `{"text":"One moment.","interim":true}` emitted when a turn ran tools |
| 2FA inbox | code from an unknown sender dropped as a conversation, still read back through the tool |
| Stranger DM | 200 + ignored, no reply sent |
| Guest in inactive group | 409, so the provider redelivers |
| Forged signature | 401 |

One real bug was found and fixed this way: the voice cursor was written in the
stream's `flush`, but ending the response with `controller.terminate()` closes
the readable without ever calling `flush`. The cursor stayed at 0, so turn two
of a call re-read turn one's events and spoke its answer again. It is now
written at each terminate point, with `flush` as the fallback for a source that
ends on its own.

Not yet verified: anything against the real AgentPhone API (no key present), and
group activation, which needs an owner-spoken message in a real group thread.

## Verification

`npm run typecheck` and `npm run build` are the only checks this repo has (no
lint, no test script). Beyond those:

- The stub covers every operation, mirroring `scripts/spectrum-stub.mjs`: it is
  the provider, never imports app code, duplicates the signing function rather
  than importing it (so a signing bug can't cancel itself out), and exposes
  readable/clearable recorded state.
- `POST /v1/webhooks/test` fires a real signed payload at our endpoint.
- Live checks against the real API are scripted and minimal, because there is no
  test mode: provision one number, send one text, place one short call.

## Open items

- `AGENTPHONE_API_KEY` is not yet in `apps/eve/.env.local`.
- Inbound webhooks need a public URL; they cannot be registered against
  `next dev`. Local development goes through the stub, or ngrok for a real
  round-trip.
- 10DLC is a 7–10 business day carrier review and gates **only** outbound SMS to
  US numbers. Everything else — inbound SMS, all iMessage, all voice — works
  immediately, so registration is submitted early and does not block the build.
