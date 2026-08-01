// A local stand-in for Photon's Spectrum cloud, for exercising the iMessage
// capability without a Photon account or a real iMessage line. Two surfaces:
//
// 1. The send API the router uses instead of the spectrum-ts SDK when
//    SPECTRUM_API_BASE_URL points here. Sends are recorded and printed, so a
//    test can read the OTP pairing code the way a human reads their phone.
// 2. A delivery trigger that plays the part of Spectrum's webhook worker:
//    POST /v1/deliver builds a real `messages` event for a given sender and
//    text, signs it with the v0 HMAC scheme (identical to production), and
//    POSTs it to the router's /api/imessage/spectrum endpoint.
//
//   node scripts/spectrum-stub.mjs                    # 127.0.0.1:4547
//   SPECTRUM_API_BASE_URL=http://127.0.0.1:4547 \
//   SPECTRUM_WEBHOOK_SECRET=<same secret you pass to /v1/deliver> npm run dev
//
// Endpoints:
//   POST   /v1/send      { handle | spaceId, phone?, ...one of:
//                          text } | { text, effect } |
//                          { attachment: { url, name?, contentType? } } |
//                          { reaction: { emoji, targetMessageId } } |
//                          { richlink } | { background } |
//                          { contactCard: true }         -> { ok, messageId }
//                        (spaceId targets a group chat; plain text only)
//   POST   /v1/typing    { handle, state, phone? }       -> { ok }
//   POST   /v1/read      { handle, messageId?, phone? }  -> { ok }
//   GET    /v1/attachment/:id                            -> image/png bytes
//   GET    /v1/sends                                     -> { sends: [...] }
//   DELETE /v1/sends                                     -> { ok }
//   GET    /v1/signals                                   -> { signals: [...] }
//   DELETE /v1/signals                                   -> { ok }
//   POST   /v1/deliver   { webhookUrl, secret, handle, text?, content?,
//                          spaceId?, spaceType?, messageId? } -> { status, body }
//                        (spaceType "group" simulates a group-chat message)
//   POST   /v1/command   any v2 typed router command -> idempotent provider result
//   POST   /v1/deliver-batch { deliveries: deliver[], order?: number[] }
//                        exercises duplicates and out-of-order webhook arrival

import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const PORT = Number.parseInt(process.env.PORT ?? "4547", 10);

/** @type {{ id: string, handle: string | null, spaceId: string | null, text?: string, attachment?: { url: string, name?: string, contentType?: string }, phone: string | null, at: string }[]} */
const sends = [];
const commandResults = new Map();

/** Typing and read-receipt control signals, in arrival order. */
/** @type {{ kind: "typing" | "read", handle: string, state?: string, messageId?: string, phone: string | null, at: string }[]} */
const signals = [];

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function signV0(secret, timestamp, rawBody) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

// --- Tiny PNG encoder (solid color) — the attachment endpoint's payload ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid solid-color truecolor PNG, decodable by any image pipeline. */
function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)]);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const RED_SQUARE_PNG = solidPng(64, 64, [220, 30, 30]);

/** The wire shape of one Spectrum `messages` delivery (DM or group chat). */
function messagesEvent({ handle, text, content, spaceId, spaceType, messageId, linePhone }) {
  const space = {
    id: spaceId ?? `any;-;${handle}`,
    platform: "iMessage",
    type: spaceType === "group" ? "group" : "dm",
    phone: linePhone ?? "+15550009999",
  };
  return {
    event: "messages",
    space,
    message: {
      id: messageId ?? `spc-msg-${randomUUID()}`,
      platform: "iMessage",
      direction: "inbound",
      timestamp: new Date().toISOString(),
      sender: { id: handle, platform: "iMessage" },
      space,
      content: content ?? { type: "text", text },
    },
  };
}

async function deliverWebhook(body) {
  const content =
    body.content !== null && typeof body.content === "object"
      ? body.content
      : undefined;
  if (
    typeof body.webhookUrl !== "string" ||
    typeof body.secret !== "string" ||
    typeof body.handle !== "string" ||
    (typeof body.text !== "string" && content === undefined)
  ) {
    throw new Error("deliver needs { webhookUrl, secret, handle } plus text or content");
  }
  const payload = JSON.stringify(
    messagesEvent({
      handle: body.handle,
      text: body.text,
      content,
      spaceId: typeof body.spaceId === "string" ? body.spaceId : undefined,
      spaceType: typeof body.spaceType === "string" ? body.spaceType : undefined,
      messageId: typeof body.messageId === "string" ? body.messageId : undefined,
      linePhone: typeof body.linePhone === "string" ? body.linePhone : undefined,
    }),
  );
  const attempts = Math.min(10, Math.max(1, Number(body.duplicates ?? 1)));
  const answers = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (Number(body.delayMs) > 0) {
      await new Promise((resolve) => setTimeout(resolve, Number(body.delayMs)));
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = body.signatureValid === false ? `${body.secret}-wrong` : body.secret;
    const delivered = await fetch(body.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "spectrum-webhook/0.1.0 (stub)",
        "x-spectrum-event": "messages",
        "x-spectrum-webhook-id":
          typeof body.webhookId === "string" ? body.webhookId : randomUUID(),
        "x-spectrum-timestamp": timestamp,
        "x-spectrum-signature": signV0(secret, timestamp, payload),
      },
      body: payload,
    });
    answers.push({ status: delivered.status, body: await delivered.text() });
  }
  return answers;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const route = `${request.method} ${url.pathname}`;

  try {
    if (route === "POST /v1/send") {
      const body = JSON.parse(await readBody(request));
      const attachment =
        body.attachment !== null && typeof body.attachment === "object" && typeof body.attachment.url === "string"
          ? {
              url: body.attachment.url,
              ...(typeof body.attachment.name === "string" ? { name: body.attachment.name } : {}),
              ...(typeof body.attachment.contentType === "string"
                ? { contentType: body.attachment.contentType }
                : {}),
            }
          : null;
      const reaction =
        body.reaction !== null &&
        typeof body.reaction === "object" &&
        typeof body.reaction.emoji === "string" &&
        typeof body.reaction.targetMessageId === "string"
          ? { emoji: body.reaction.emoji, targetMessageId: body.reaction.targetMessageId }
          : null;
      const hasContent =
        typeof body.text === "string" ||
        attachment !== null ||
        reaction !== null ||
        typeof body.richlink === "string" ||
        typeof body.background === "string" ||
        body.contactCard === true;
      const handle = typeof body.handle === "string" ? body.handle : null;
      const spaceId = typeof body.spaceId === "string" ? body.spaceId : null;
      if ((handle === null && spaceId === null) || !hasContent) {
        return json(response, 400, {
          error:
            "send needs { handle | spaceId } plus text, attachment, reaction, richlink, background, or contactCard",
        });
      }
      const record = {
        id: `spc-msg-${randomUUID()}`,
        handle,
        spaceId,
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        ...(typeof body.effect === "string" ? { effect: body.effect } : {}),
        ...(attachment !== null ? { attachment } : {}),
        ...(reaction !== null ? { reaction } : {}),
        ...(typeof body.richlink === "string" ? { richlink: body.richlink } : {}),
        ...(typeof body.background === "string" ? { background: body.background } : {}),
        ...(body.contactCard === true ? { contactCard: true } : {}),
        phone: typeof body.phone === "string" ? body.phone : null,
        at: new Date().toISOString(),
      };
      sends.push(record);
      console.log("[spectrum-stub] recorded one outbound send");
      return json(response, 200, { ok: true, messageId: record.id });
    }

    if (route === "POST /v1/command") {
      const body = JSON.parse(await readBody(request));
      if (
        body.version !== 2 ||
        typeof body.commandId !== "string" ||
        typeof body.operation !== "string" ||
        body.target === null ||
        typeof body.target !== "object"
      ) {
        return json(response, 400, { error: "command needs a typed v2 command" });
      }
      const replay = commandResults.get(body.commandId);
      if (replay !== undefined) return json(response, 200, replay);
      const providerMessageId =
        body.operation === "unsend" ||
        body.operation === "remove_background" ||
        body.operation === "set_typing" ||
        body.operation === "mark_read" ||
        body.operation === "leave_group" ||
        body.operation === "archive_chat"
          ? undefined
          : `spc-msg-${randomUUID()}`;
      const choices =
        body.payload !== null &&
        typeof body.payload === "object" &&
        Array.isArray(body.payload.choices)
          ? body.payload.choices
          : [];
      const result =
        body.operation === "send_poll"
          ? {
              optionIds: choices.map((_, index) => `poll-option-${index + 1}`),
            }
          : body.operation === "create_group"
            ? { spaceId: `spc-space-${randomUUID()}` }
            : body.operation === "send_app"
              ? { miniAppCardSession: `app-session-${randomUUID()}` }
              : undefined;
      const answer = {
        ...(providerMessageId === undefined ? {} : { providerMessageId }),
        ...(result === undefined ? {} : { result }),
      };
      commandResults.set(body.commandId, answer);
      sends.push({
        id: providerMessageId ?? `spc-op-${randomUUID()}`,
        handle: body.target.kind === "dm" ? body.target.handle : null,
        spaceId: body.target.kind === "space" ? body.target.spaceId : null,
        operation: body.operation,
        payload: body.payload,
        commandId: body.commandId,
        phone: typeof body.phone === "string" ? body.phone : null,
        at: new Date().toISOString(),
      });
      return json(response, 200, answer);
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/attachment/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/attachment/".length));
      if (id.length === 0) return json(response, 404, { error: "no attachment id" });
      console.log("[spectrum-stub] served one attachment");
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": RED_SQUARE_PNG.length,
        "x-attachment-name": "red-square.png",
      });
      return response.end(RED_SQUARE_PNG);
    }

    if (route === "POST /v1/typing") {
      const body = JSON.parse(await readBody(request));
      if (typeof body.handle !== "string" || (body.state !== "start" && body.state !== "stop")) {
        return json(response, 400, { error: "typing needs { handle, state: start|stop }" });
      }
      const record = {
        kind: /** @type {const} */ ("typing"),
        handle: body.handle,
        state: body.state,
        phone: typeof body.phone === "string" ? body.phone : null,
        at: new Date().toISOString(),
      };
      signals.push(record);
      console.log(`[spectrum-stub] typing ${record.state}`);
      return json(response, 200, { ok: true });
    }

    if (route === "POST /v1/read") {
      const body = JSON.parse(await readBody(request));
      if (typeof body.handle !== "string") {
        return json(response, 400, { error: "read needs { handle }" });
      }
      const record = {
        kind: /** @type {const} */ ("read"),
        handle: body.handle,
        messageId: typeof body.messageId === "string" ? body.messageId : undefined,
        phone: typeof body.phone === "string" ? body.phone : null,
        at: new Date().toISOString(),
      };
      signals.push(record);
      console.log("[spectrum-stub] recorded a read signal");
      return json(response, 200, { ok: true });
    }

    if (route === "GET /v1/sends") {
      return json(response, 200, { sends });
    }

    if (route === "DELETE /v1/sends") {
      sends.length = 0;
      commandResults.clear();
      return json(response, 200, { ok: true });
    }

    if (route === "GET /v1/signals") {
      return json(response, 200, { signals });
    }

    if (route === "DELETE /v1/signals") {
      signals.length = 0;
      return json(response, 200, { ok: true });
    }

    if (route === "POST /v1/deliver") {
      const body = JSON.parse(await readBody(request));
      const answers = await deliverWebhook(body);
      const answered = answers.at(-1) ?? { status: 500, body: "" };
      console.log(
        `[spectrum-stub] deliver -> HTTP ${answered.status}`,
      );
      return json(response, 200, {
        status: answered.status,
        body: answered.body,
        attempts: answers,
      });
    }

    if (route === "POST /v1/deliver-batch") {
      const body = JSON.parse(await readBody(request));
      if (!Array.isArray(body.deliveries) || body.deliveries.length === 0) {
        return json(response, 400, { error: "deliver-batch needs deliveries[]" });
      }
      const order = Array.isArray(body.order)
        ? body.order
        : body.deliveries.map((_, index) => index);
      const answers = [];
      for (const index of order) {
        const delivery = body.deliveries[Number(index)];
        if (delivery === undefined) continue;
        answers.push(...(await deliverWebhook(delivery)));
      }
      return json(response, 200, { answers });
    }

    return json(response, 404, { error: `no route for ${route}` });
  } catch (error) {
    console.error(`[spectrum-stub] ${route} failed`, error);
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[spectrum-stub] listening at http://127.0.0.1:${PORT}`);
  console.log(`[spectrum-stub] point the router here with SPECTRUM_API_BASE_URL=http://127.0.0.1:${PORT}`);
});
