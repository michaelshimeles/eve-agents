import { experimental_upgradeWebSocket, type WebSocketData } from "@vercel/functions";

import { orgo } from "@/agent/lib/orgo";
import { requireWebAuth } from "@/lib/web-auth";

// Same-origin relay between the browser's VNC client and Orgo's websockify
// endpoint. Orgo only admits browser origins it knows about (orgo.ai and
// http://localhost:3000); a WebSocket opened from a deployed page is cut off
// right after the upgrade with 4001 "Origin not allowed". Dialing Orgo from
// the server sidesteps that — a server-side WebSocket sends no Origin header
// — so the page connects here and the bytes are piped through.
//
// Upgrades only work on the Vercel runtime (`experimental_upgradeWebSocket`);
// under `next dev` this route answers 501, and the panel never uses it there
// because localhost pages get Orgo's direct URL, which Orgo admits.
//
// This socket is full control of the desktop, exactly like the connection
// details GET /api/computer hands out; it is gated by the same web auth.

export const maxDuration = 300;

/**
 * A VNC client has nothing to say until the server greets it, so frames held
 * back while the upstream leg is still connecting should amount to nothing.
 * The cap turns a client that floods that window anyway into a closed socket
 * instead of unbounded function memory.
 */
const MAX_BACKLOG_BYTES = 64 * 1024;

/**
 * A close code seen on one leg is re-sent on the other, but only codes that
 * are legal to send (1005/1006/1015 are receive-only, and anything outside
 * the RFC ranges throws): everything else degrades to 1000.
 */
function relayCode(code: number): number {
  const sendable =
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1011) ||
    (code >= 3000 && code <= 4999);
  return sendable ? code : 1000;
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  // Resolve the upstream before upgrading, so a desktop with nothing to
  // connect to is an HTTP error instead of a socket that opens and drops.
  let upstreamUrl: string;
  try {
    const { connection } = await orgo.live();
    if (connection === null) {
      return new Response("The desktop has nothing to connect to.", { status: 409 });
    }
    upstreamUrl = connection.websocketUrl;
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Orgo request failed.", {
      status: 502,
    });
  }

  try {
    return await experimental_upgradeWebSocket((client) => {
      const upstream = new WebSocket(upstreamUrl);
      upstream.binaryType = "arraybuffer";

      // Frames the browser sends before the upstream leg finishes its own
      // handshake are held back, within MAX_BACKLOG_BYTES.
      const backlog: (Buffer | ArrayBuffer)[] = [];
      let backlogBytes = 0;

      client.on("message", (data: WebSocketData) => {
        const frame = Array.isArray(data) ? Buffer.concat(data) : data;
        if (upstream.readyState === WebSocket.CONNECTING) {
          backlogBytes += frame.byteLength;
          if (backlogBytes > MAX_BACKLOG_BYTES) {
            client.close(1008, "Too much data before the desktop link opened.");
            upstream.close();
            return;
          }
          backlog.push(frame);
        } else {
          upstream.send(frame);
        }
      });
      client.on("close", () => upstream.close());
      client.on("error", () => upstream.close());

      upstream.onopen = () => {
        for (const frame of backlog) upstream.send(frame);
        backlog.length = 0;
      };
      upstream.onmessage = (event: MessageEvent) => {
        client.send(event.data as string | ArrayBuffer);
      };
      upstream.onclose = (event: CloseEvent) => {
        client.close(relayCode(event.code), event.reason.slice(0, 100));
      };
      upstream.onerror = () => client.close(1011, "The desktop connection failed.");
    });
  } catch {
    return new Response("WebSocket upgrades are unavailable in this runtime.", { status: 501 });
  }
}
