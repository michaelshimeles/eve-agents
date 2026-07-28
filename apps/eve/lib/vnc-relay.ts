import type { RawData, WebSocket as ClientSocket } from "ws";

// The piping half of the VNC relay, shared by the deployed relay route
// (app/api/computer/ws) and the local-dev sidecar (lib/dev-vnc-relay). One
// leg is a browser's noVNC socket, the other is Orgo's websockify endpoint
// dialed from the server — where no Origin header is sent, which is the
// whole point: Orgo's proxy only admits browser origins it knows about and
// cuts everything else off after the upgrade with 4001 "Origin not allowed".

/**
 * A VNC client has nothing to say until the server greets it, so frames held
 * back while the upstream leg is still connecting should amount to nothing.
 * The cap turns a client that floods that window anyway into a closed socket
 * instead of unbounded server memory.
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

/** Pipe an accepted client socket to Orgo's websockify endpoint, both ways. */
export function pipeVncSocket(client: ClientSocket, upstreamUrl: string): void {
  const upstream = new WebSocket(upstreamUrl);
  upstream.binaryType = "arraybuffer";

  // Frames the browser sends before the upstream leg finishes its own
  // handshake are held back, within MAX_BACKLOG_BYTES.
  const backlog: (Buffer | ArrayBuffer)[] = [];
  let backlogBytes = 0;

  client.on("message", (data: RawData) => {
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
}
