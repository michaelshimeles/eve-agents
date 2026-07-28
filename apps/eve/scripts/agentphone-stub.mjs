#!/usr/bin/env node
// A local stand-in for AgentPhone (https://api.agentphone.ai).
//
// AgentPhone has no sandbox, no test-mode keys, and no magic numbers: every
// call hits production and bills real money ($3/month a number, $0.02 a text,
// $0.13/min a call). So this exists to make the whole integration exercisable
// without an account.
//
// Two surfaces, like scripts/spectrum-stub.mjs:
//   1. The REST API the app calls  — provision, send, call, inbox, webhooks.
//   2. The delivery trigger        — plays AgentPhone's webhook worker, signing
//                                    payloads the way the real one does and
//                                    POSTing them at the app.
//
// It never imports app code, and it re-implements the signature rather than
// importing it, so a signing bug on either side cannot cancel itself out.
//
//   node apps/eve/scripts/agentphone-stub.mjs
//   AGENTPHONE_API_BASE_URL=http://127.0.0.1:4548 AGENTPHONE_API_KEY=stub npm run dev
//
// Then drive it:
//   curl -X POST localhost:4548/v1/deliver -H 'content-type: application/json' \
//     -d '{"webhookUrl":"http://localhost:3000/eve/v1/agentphone/inbound",
//          "secret":"whsec_stub","from":"+15551234567","text":"hey"}'
//   curl localhost:4548/v1/sends          # what the app tried to send
//   curl -X DELETE localhost:4548/v1/sends

import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.AGENTPHONE_STUB_PORT ?? 4548);
const LINE = process.env.AGENTPHONE_STUB_LINE ?? "+15550001111";
const SECRET = process.env.AGENTPHONE_STUB_WEBHOOK_SECRET ?? "whsec_stub";

/** Everything the app sent, newest last. Readable and clearable. */
const sends = [];
/** Typing indicators, reactions, and other non-message signals. */
const signals = [];
/** Inbound texts, so GET /v1/numbers/:id/messages can serve the 2FA inbox. */
const inbox = [];

const state = {
  numberId: "num_stub0001",
  agentId: null,
  webhookUrl: null,
};

// Duplicated from agent/lib/agentphone-signature.ts on purpose: the stub is
// the provider, and a shared helper would let a wrong canonical string pass
// both sides.
function sign(secret, timestamp, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Builds the envelope AgentPhone posts for an inbound text. */
function messageEvent(input) {
  const conversationId = input.conversationId ?? `conv_${input.from.replace(/\D/g, "")}`;
  return {
    event: "agent.message",
    channel: input.channel ?? "imessage",
    timestamp: new Date().toISOString(),
    agentId: state.agentId ?? "agt_stub",
    data: {
      id: input.messageId ?? `msg_${randomUUID()}`,
      conversationId,
      numberId: state.numberId,
      from: input.from,
      to: LINE,
      message: input.text ?? "",
      mediaUrl: input.mediaUrl ?? null,
      direction: "inbound",
      receivedAt: new Date().toISOString(),
      ...(input.groupId === undefined
        ? {}
        : {
            senderIdentifier: input.from,
            group: {
              isGroup: true,
              groupId: input.groupId,
              groupName: input.groupName ?? "Stub Group",
              groupIconUrl: null,
              participants: [{ identifier: input.from, name: null }],
            },
          }),
    },
  };
}

/** Builds the envelope AgentPhone posts for one spoken turn of a live call. */
function voiceEvent(input) {
  return {
    event: "agent.message",
    channel: "voice",
    timestamp: new Date().toISOString(),
    agentId: state.agentId ?? "agt_stub",
    data: {
      callId: input.callId ?? "call_stub0001",
      numberId: state.numberId,
      from: input.from,
      to: LINE,
      transcript: input.text ?? "",
      confidence: 0.95,
      status: "in-progress",
      direction: input.direction ?? "inbound",
    },
  };
}

async function deliver(body) {
  const event =
    body.kind === "voice" ? voiceEvent(body) : messageEvent(body);
  const raw = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = body.secret ?? SECRET;

  const response = await fetch(body.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": sign(secret, timestamp, raw),
      "x-webhook-timestamp": timestamp,
      "x-webhook-id": `whd_${randomUUID()}`,
      "x-webhook-event": event.event,
    },
    body: raw,
  });

  const text = await response.text();
  if (body.kind !== "voice") {
    inbox.push({
      id: event.data.id,
      from_: body.from,
      to: LINE,
      body: body.text ?? "",
      direction: "inbound",
      channel: event.channel,
      receivedAt: event.data.receivedAt,
    });
  }
  // For a voice delivery the body IS the agent's spoken reply, so hand the
  // NDJSON back verbatim — that is the thing under test.
  return { status: response.status, body: text };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // --- inspection -----------------------------------------------------------
  if (method === "GET" && path === "/v1/sends") return json(res, 200, { data: sends });
  if (method === "DELETE" && path === "/v1/sends") {
    sends.length = 0;
    return json(res, 200, { ok: true });
  }
  if (method === "GET" && path === "/v1/signals") return json(res, 200, { data: signals });
  if (method === "DELETE" && path === "/v1/signals") {
    signals.length = 0;
    return json(res, 200, { ok: true });
  }

  // --- delivery trigger (plays AgentPhone's webhook worker) -----------------
  if (method === "POST" && path === "/v1/deliver") {
    const body = await readBody(req);
    if (typeof body.webhookUrl !== "string") {
      return json(res, 400, { error: { message: "webhookUrl is required" } });
    }
    try {
      return json(res, 200, await deliver(body));
    } catch (error) {
      return json(res, 502, { error: { message: String(error) } });
    }
  }

  // --- the REST API ---------------------------------------------------------
  if (method === "POST" && path === "/v1/agents") {
    const body = await readBody(req);
    state.agentId = `agt_${randomUUID().slice(0, 8)}`;
    return json(res, 200, {
      id: state.agentId,
      name: body.name ?? "Agent",
      voiceMode: body.voiceMode ?? "webhook",
      voice: "Polly.Amy",
      createdAt: new Date().toISOString(),
    });
  }

  if (method === "GET" && path === "/v1/numbers") {
    // Empty until provisioned, so the "adopt an existing number" branch and
    // the "buy one" branch are both reachable.
    return json(res, 200, {
      data: state.provisioned
        ? [{ id: state.numberId, phoneNumber: LINE, country: "US", status: "active", type: "sms" }]
        : [],
      hasMore: false,
      total: state.provisioned ? 1 : 0,
    });
  }

  if (method === "POST" && path === "/v1/numbers") {
    state.provisioned = true;
    return json(res, 200, {
      id: state.numberId,
      phoneNumber: LINE,
      country: "US",
      status: "active",
      type: "sms",
      agentId: state.agentId,
      createdAt: new Date().toISOString(),
    });
  }

  if (method === "DELETE" && path.startsWith("/v1/numbers/")) {
    state.provisioned = false;
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && /^\/v1\/numbers\/[^/]+\/messages$/.test(path)) {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return json(res, 200, { data: inbox.slice(-limit).reverse(), hasMore: false });
  }

  if (method === "POST" && /^\/v1\/agents\/[^/]+\/numbers$/.test(path)) {
    return json(res, 200, {
      agentId: state.agentId,
      number: { id: state.numberId, phoneNumber: LINE, status: "active", type: "sms" },
    });
  }

  if (method === "POST" && path === "/v1/webhooks") {
    const body = await readBody(req);
    state.webhookUrl = body.url ?? null;
    // The real API mints a NEW secret on every create and update; mirroring
    // that is what proves the caller persists whatever comes back.
    return json(res, 200, {
      id: "whk_stub",
      url: state.webhookUrl,
      secret: SECRET,
      status: "active",
      contextLimit: body.contextLimit ?? 0,
      timeout: body.timeout ?? 30,
      createdAt: new Date().toISOString(),
    });
  }

  if (method === "POST" && path === "/v1/messages") {
    const body = await readBody(req);
    const record = {
      at: new Date().toISOString(),
      to: body.to_number,
      body: body.body ?? "",
      mediaUrls: body.media_urls ?? [],
      sendStyle: body.send_style ?? null,
      replyTo: body.reply_to_message_id ?? null,
    };
    sends.push(record);
    const preview = record.body.length > 60 ? `${record.body.slice(0, 60)}...` : record.body;
    console.log(`[agentphone-stub] -> ${record.to}: ${preview}`);
    return json(res, 200, {
      id: `msg_${randomUUID()}`,
      status: "sent",
      channel: String(body.to_number ?? "").startsWith("grp_") ? "imessage" : "sms",
      from_number: LINE,
      to_number: body.to_number,
      conversation_id: `conv_${String(body.to_number ?? "").replace(/\D/g, "")}`,
      media_urls: record.mediaUrls,
    });
  }

  if (method === "POST" && /^\/v1\/messages\/[^/]+\/reactions$/.test(path)) {
    const body = await readBody(req);
    signals.push({ kind: "reaction", at: new Date().toISOString(), reaction: body.reaction });
    return json(res, 200, {
      id: `rxn_${randomUUID()}`,
      reaction_type: body.reaction,
      message_id: path.split("/")[3],
      channel: "iMessage",
    });
  }

  if (method === "POST" && /^\/v1\/conversations\/[^/]+\/typing$/.test(path)) {
    signals.push({ kind: "typing", at: new Date().toISOString(), conversation: path.split("/")[3] });
    return json(res, 200, {
      conversationId: path.split("/")[3],
      channel: "imessage",
      status: "typing indicator sent",
    });
  }

  if (method === "GET" && path === "/v1/contacts/capabilities") {
    const number = url.searchParams.get("phone_number") ?? "";
    return json(res, 200, {
      phoneNumber: number,
      // Odd last digit reads as an Android number, so both branches are
      // reachable without configuring anything.
      capabilities: { imessage: !/[13579]$/.test(number), sms: true },
      checkedAt: new Date().toISOString(),
    });
  }

  if (method === "POST" && path === "/v1/calls") {
    const body = await readBody(req);
    const callId = `call_${randomUUID().slice(0, 8)}`;
    sends.push({ at: new Date().toISOString(), kind: "call", to: body.toNumber, callId });
    console.log(
      `[agentphone-stub] -> calling ${body.toNumber} (${body.systemPrompt ? "scripted" : "webhook"})`,
    );
    return json(res, 200, { id: callId, status: "queued", toNumber: body.toNumber });
  }

  if (method === "GET" && path === "/v1/register/status") {
    return json(res, 200, {
      campaign_status: process.env.AGENTPHONE_STUB_CAMPAIGN ?? "approved",
      message: "stub",
      stage: null,
    });
  }

  if (method === "GET" && path === "/v1/usage") {
    return json(res, 200, { balance: 500, numbers: state.provisioned ? 1 : 0 });
  }

  json(res, 404, { error: { message: `No stub route for ${method} ${path}`, code: "NOT_FOUND" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[agentphone-stub] listening on http://127.0.0.1:${PORT}`);
  console.log(`[agentphone-stub] line ${LINE}, webhook secret ${SECRET}`);
  console.log(`[agentphone-stub] set AGENTPHONE_API_BASE_URL=http://127.0.0.1:${PORT}`);
});
