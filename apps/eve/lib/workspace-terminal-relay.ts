import type { RawData, WebSocket as ClientSocket } from "ws";

const MAX_BACKLOG_BYTES = 1024 * 1024;

function relayCloseCode(code: number): number {
  const sendable =
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1011) ||
    (code >= 3000 && code <= 4999);
  return sendable ? code : 1000;
}

export function workspaceInteractiveUrl(credentials: { url: string; token: string }): string {
  const url = new URL(credentials.url);
  url.searchParams.set("token", credentials.token);
  return url.toString();
}

export function pipeWorkspaceTerminal(
  client: ClientSocket,
  credentials: { url: string; token: string },
): void {
  const upstream = new WebSocket(workspaceInteractiveUrl(credentials));
  upstream.binaryType = "arraybuffer";

  const backlog: { frame: string | Buffer | ArrayBuffer; binary: boolean }[] = [];
  let backlogBytes = 0;

  client.on("message", (data: RawData, isBinary: boolean) => {
    const raw = Array.isArray(data) ? Buffer.concat(data) : data;
    const frame = isBinary ? raw : raw.toString();
    if (upstream.readyState === WebSocket.CONNECTING) {
      backlogBytes += typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
      if (backlogBytes > MAX_BACKLOG_BYTES) {
        client.close(1008, "Too much data before the terminal opened.");
        upstream.close();
        return;
      }
      backlog.push({ frame, binary: isBinary });
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
  });
  client.on("close", () => upstream.close());
  client.on("error", () => upstream.close());

  upstream.onopen = () => {
    for (const item of backlog) upstream.send(item.frame);
    backlog.length = 0;
    backlogBytes = 0;
  };
  upstream.onmessage = (event: MessageEvent) => {
    client.send(event.data as string | ArrayBuffer);
  };
  upstream.onclose = (event: CloseEvent) => {
    client.close(relayCloseCode(event.code), event.reason.slice(0, 100));
  };
  upstream.onerror = () => client.close(1011, "The terminal connection failed.");
}
