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
//   POST   /v1/send      { handle, text, phone? }        -> { ok, messageId }
//   GET    /v1/sends                                     -> { sends: [...] }
//   DELETE /v1/sends                                     -> { ok }
//   POST   /v1/deliver   { webhookUrl, secret, handle, text,
//                          spaceId?, messageId? }        -> { status, body }

import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.PORT ?? "4547", 10);

/** @type {{ id: string, handle: string, text: string, phone: string | null, at: string }[]} */
const sends = [];

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

/** The wire shape of one Spectrum `messages` delivery for an iMessage DM. */
function messagesEvent({ handle, text, spaceId, messageId, linePhone }) {
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
      content: { type: "text", text },
    },
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const route = `${request.method} ${url.pathname}`;

  try {
    if (route === "POST /v1/send") {
      const body = JSON.parse(await readBody(request));
      if (typeof body.handle !== "string" || typeof body.text !== "string") {
        return json(response, 400, { error: "send needs { handle, text }" });
      }
      const record = {
        id: `spc-msg-${randomUUID()}`,
        handle: body.handle,
        text: body.text,
        phone: typeof body.phone === "string" ? body.phone : null,
        at: new Date().toISOString(),
      };
      sends.push(record);
      console.log(`[spectrum-stub] send -> ${record.handle}: ${record.text}`);
      return json(response, 200, { ok: true, messageId: record.id });
    }

    if (route === "GET /v1/sends") {
      return json(response, 200, { sends });
    }

    if (route === "DELETE /v1/sends") {
      sends.length = 0;
      return json(response, 200, { ok: true });
    }

    if (route === "POST /v1/deliver") {
      const body = JSON.parse(await readBody(request));
      if (
        typeof body.webhookUrl !== "string" ||
        typeof body.secret !== "string" ||
        typeof body.handle !== "string" ||
        typeof body.text !== "string"
      ) {
        return json(response, 400, { error: "deliver needs { webhookUrl, secret, handle, text }" });
      }
      const payload = JSON.stringify(
        messagesEvent({
          handle: body.handle,
          text: body.text,
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
