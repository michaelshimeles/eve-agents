import type { RawData, WebSocket as ClientSocket } from "ws";

import type { WorkspaceUploadHandle } from "@/agent/lib/effect/sandbox-workspace";
import { runApp } from "@/agent/lib/effect/runtime";

export const WORKSPACE_TRANSFER_CHUNK_BYTES = 256 * 1024;

export function serveWorkspaceUpload(
  client: ClientSocket,
  upload: WorkspaceUploadHandle,
  expectedBytes: number,
): void {
  let received = 0;
  let settled = false;
  let queue = Promise.resolve();

  const fail = (message: string): void => {
    if (settled) return;
    settled = true;
    void runApp(upload.abort()).finally(() => client.close(1011, message.slice(0, 100)));
  };

  client.on("message", (data: RawData, isBinary: boolean) => {
    queue = queue.then(async () => {
      if (settled) return;
      if (isBinary) {
        const chunk = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        if (chunk.byteLength === 0 || chunk.byteLength > WORKSPACE_TRANSFER_CHUNK_BYTES) {
          fail("The upload chunk is invalid.");
          return;
        }
        await runApp(upload.append(chunk));
        received += chunk.byteLength;
        client.send(JSON.stringify({ type: "progress", received, expected: expectedBytes }));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        fail("The upload control message is invalid.");
        return;
      }
      if (
        message === null ||
        typeof message !== "object" ||
        !("type" in message) ||
        message.type !== "commit"
      ) {
        fail("The upload control message is invalid.");
        return;
      }
      await runApp(upload.commit());
      settled = true;
      client.send(JSON.stringify({ type: "complete", received }));
      client.close(1000, "Upload complete.");
    }).catch((error) => {
      fail(error instanceof Error ? error.message : "Upload failed.");
    });
  });

  client.on("close", () => {
    if (!settled) void runApp(upload.abort()).catch(() => undefined);
  });
  client.on("error", () => {
    if (!settled) void runApp(upload.abort()).catch(() => undefined);
  });

  client.send(
    JSON.stringify({
      type: "ready",
      expected: expectedBytes,
      maxChunkBytes: WORKSPACE_TRANSFER_CHUNK_BYTES,
    }),
  );
}
