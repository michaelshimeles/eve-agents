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
//   POST   /v1/send      { handle, phone?, ...one of:
//                          text } | { text, effect } |
//                          { attachment: { url, name?, contentType? } } |
//                          { reaction: { emoji, targetMessageId } } |
//                          { richlink } | { background } |
//                          { contactCard: true }         -> { ok, messageId }
//   POST   /v1/typing    { handle, state, phone? }       -> { ok }
//   POST   /v1/read      { handle, messageId?, phone? }  -> { ok }
//   GET    /v1/attachment/:id                            -> image/png bytes
//   GET    /v1/sends                                     -> { sends: [...] }
//   DELETE /v1/sends                                     -> { ok }
//   GET    /v1/signals                                   -> { signals: [...] }
//   DELETE /v1/signals                                   -> { ok }
//   POST   /v1/deliver   { webhookUrl, secret, handle, text?, content?,
//                          spaceId?, messageId? }        -> { status, body }

import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const PORT = Number.parseInt(process.env.PORT ?? "4547", 10);

/** @type {{ id: string, handle: string, text?: string, attachment?: { url: string, name?: string, contentType?: string }, phone: string | null, at: string }[]} */
const sends = [];

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

/** The wire shape of one Spectrum `messages` delivery for an iMessage DM. */
function messagesEvent({ handle, text, content, spaceId, messageId, linePhone }) {
  const space = {
    id: spaceId ?? `any;-;${handle}`,
    platform: "iMessage",
    type: "dm",
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
      if (typeof body.handle !== "string" || !hasContent) {
        return json(response, 400, {
          error: "send needs { handle } plus text, attachment, reaction, richlink, background, or contactCard",
        });
      }
      const record = {
        id: `spc-msg-${randomUUID()}`,
        handle: body.handle,
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
      const summary =
        record.text !== undefined
          ? `${record.text}${record.effect !== undefined ? ` [effect ${record.effect}]` : ""}`
          : record.attachment !== undefined
            ? `[attachment ${record.attachment.url}]`
            : record.reaction !== undefined
              ? `[reaction ${record.reaction.emoji} -> ${record.reaction.targetMessageId}]`
              : record.richlink !== undefined
                ? `[richlink ${record.richlink}]`
                : record.background !== undefined
                  ? `[background ${record.background}]`
                  : `[contact card]`;
      console.log(`[spectrum-stub] send -> ${record.handle}: ${summary}`);
      return json(response, 200, { ok: true, messageId: record.id });
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/attachment/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/attachment/".length));
      if (id.length === 0) return json(response, 404, { error: "no attachment id" });
      console.log(`[spectrum-stub] attachment fetch <- ${id}`);
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
      console.log(`[spectrum-stub] typing ${record.state} -> ${record.handle}`);
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
      console.log(`[spectrum-stub] read -> ${record.handle} (${record.messageId ?? "chat"})`);
      return json(response, 200, { ok: true });
    }

    if (route === "GET /v1/sends") {
      return json(response, 200, { sends });
    }

    if (route === "DELETE /v1/sends") {
      sends.length = 0;
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
      const content = body.content !== null && typeof body.content === "object" ? body.content : undefined;
      if (
        typeof body.webhookUrl !== "string" ||
        typeof body.secret !== "string" ||
        typeof body.handle !== "string" ||
        (typeof body.text !== "string" && content === undefined)
      ) {
        return json(response, 400, {
          error: "deliver needs { webhookUrl, secret, handle } plus text or content",
        });
      }
      const payload = JSON.stringify(
        messagesEvent({
          handle: body.handle,
          text: body.text,
          content,
          spaceId: typeof body.spaceId === "string" ? body.spaceId : undefined,
          messageId: typeof body.messageId === "string" ? body.messageId : undefined,
        }),
      );
      const timestamp = String(Math.floor(Date.now() / 1000));
      const delivered = await fetch(body.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "spectrum-webhook/0.1.0 (stub)",
          "x-spectrum-event": "messages",
          "x-spectrum-webhook-id": randomUUID(),
          "x-spectrum-timestamp": timestamp,
          "x-spectrum-signature": signV0(body.secret, timestamp, payload),
        },
        body: payload,
      });
      const answered = await delivered.text();
      console.log(
        `[spectrum-stub] deliver ${body.handle} -> ${body.webhookUrl} : HTTP ${delivered.status} ${answered}`,
      );
      return json(response, 200, { status: delivered.status, body: answered });
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
