import { createHash, randomBytes } from "node:crypto";
import { createServer, get } from "node:http";

import { WebSocketServer } from "ws";

import {
  openWorkspaceInteractive,
  openWorkspaceUpload,
} from "@/agent/lib/effect/sandbox-workspace";
import { runApp } from "@/agent/lib/effect/runtime";
import { pipeWorkspaceTerminal } from "@/lib/workspace-terminal-relay";
import { serveWorkspaceUpload } from "@/lib/workspace-transfer";

const DEV_RELAY_PORT = 4549;
const RELAY_URL = `ws://localhost:${DEV_RELAY_PORT}`;
const RELAY_PUBLIC_PATH = "/__eve-workspace-relay";
const PROBE_TIMEOUT_MS = 2_000;
const TOKEN_ENV = "EVE_DEV_WORKSPACE_TOKEN";

function relayToken(): string {
  let token = process.env[TOKEN_ENV];
  if (token === undefined || token.length === 0) {
    token = randomBytes(32).toString("hex");
    process.env[TOKEN_ENV] = token;
  }
  return token;
}

function ownershipProof(): string {
  return createHash("sha256").update(relayToken()).digest("hex");
}

type RelayVerdict = "own" | "sibling" | "dead";
let readiness: Promise<RelayVerdict> | undefined;

export async function devWorkspaceRelayUrl(): Promise<string | null> {
  if (process.env.NODE_ENV !== "development") return null;
  readiness ??= start();
  let verdict = await readiness;
  if (verdict !== "own") {
    readiness = start();
    verdict = await readiness;
  }
  if (verdict === "dead") return null;
  return `${RELAY_PUBLIC_PATH}?token=${relayToken()}`;
}

function tokenAllowed(requestUrl: string | undefined): boolean {
  try {
    return new URL(requestUrl ?? "/", RELAY_URL).searchParams.get("token") === relayToken();
  } catch {
    return false;
  }
}

function start(): Promise<RelayVerdict> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(426, { "Content-Type": "text/plain" });
      response.end(ownershipProof());
    });
    const relay = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      if (!tokenAllowed(request.url)) {
        socket.destroy();
        return;
      }
      const url = new URL(request.url ?? "/", RELAY_URL);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const targetName = url.searchParams.get("targetName") ?? undefined;
      if (sessionId.length === 0 || sessionId.length > 256) {
        socket.destroy();
        return;
      }
      void (async () => {
        try {
          const target = {
            sessionId,
            ...(targetName ? { targetName } : {}),
          };
          if (url.pathname === "/transfer") {
            const path = url.searchParams.get("path");
            const size = Number(url.searchParams.get("size"));
            if (path === null || !Number.isSafeInteger(size) || size < 0) {
              socket.destroy();
              return;
            }
            const upload = await runApp(
              openWorkspaceUpload(target, {
                path,
                size,
                overwrite: url.searchParams.get("overwrite") === "1",
              }),
            );
            relay.handleUpgrade(request, socket, head, (client) =>
              serveWorkspaceUpload(client, upload, size),
            );
            return;
          }
          if (url.pathname !== "/terminal") {
            socket.destroy();
            return;
          }
          const credentials = await runApp(openWorkspaceInteractive(target));
          relay.handleUpgrade(request, socket, head, (client) =>
            pipeWorkspaceTerminal(client, credentials),
          );
        } catch {
          socket.destroy();
        }
      })();
    });

    server.once("listening", () => resolve("own"));
    server.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        resolve(confirmOwnRelay());
        return;
      }
      console.warn(
        `[dev-workspace-relay] could not start on ${DEV_RELAY_PORT}: ${String(error)}`,
      );
      resolve("dead");
    });
    server.listen(DEV_RELAY_PORT, "127.0.0.1");
  });
}

function confirmOwnRelay(): Promise<RelayVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout>;
    const settle = (own: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (!own) {
        console.warn(
          `[dev-workspace-relay] port ${DEV_RELAY_PORT} is held by another process.`,
        );
      }
      resolve(own ? "sibling" : "dead");
    };
    const proof = ownershipProof();
    const request = get(
      { host: "127.0.0.1", port: DEV_RELAY_PORT, path: "/" },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > proof.length) {
            settle(false);
            request.destroy();
          }
        });
        response.on("end", () => settle(body.trim() === proof));
      },
    );
    deadline = setTimeout(() => {
      request.destroy();
      settle(false);
    }, PROBE_TIMEOUT_MS);
    request.on("error", () => settle(false));
  });
}
