import { createHash, randomBytes } from "node:crypto";
import { createServer, get } from "node:http";

import { WebSocketServer } from "ws";

import { orgo } from "@/agent/lib/orgo";
import { pipeVncSocket } from "@/lib/vnc-relay";

// Local-dev stand-in for the deployed VNC relay route. `next dev` cannot
// upgrade WebSockets inside a route handler (that needs the Vercel runtime),
// and Orgo's websockify admits no browser origin of ours, so the dev server
// runs this sidecar on its own loopback port and the panel connects here
// instead. Same resolve-then-pipe behavior as app/api/computer/ws/route.ts.
//
// Loopback binding keeps other machines out, but not other *origins*: a
// WebSocket is exempt from the same-origin policy, so any page the developer
// visits could otherwise open this socket and drive the desktop. Admission is
// therefore a per-process secret token carried in the relay URL: only code
// that can read GET /api/computer's response (i.e. the dev server's own
// same-origin page) learns it, and an attacker page cannot. The token can't
// key off the request (a DNS-rebound Host would poison an origin allowlist)
// and lives in process.env so every hot-reload generation and worker in the
// one dev process shares it — including whichever generation actually bound
// the port and thus runs the upgrade handler.

const DEV_RELAY_PORT = 4548;
const RELAY_URL = `ws://localhost:${DEV_RELAY_PORT}`;

/** How long to wait on the port-ownership probe before treating it as failed. */
const PROBE_TIMEOUT_MS = 2_000;

/** Process-global so it survives module re-evaluation and is shared across workers. */
const TOKEN_ENV = "EVE_DEV_VNC_TOKEN";

function relayToken(): string {
  let token = process.env[TOKEN_ENV];
  if (token === undefined || token.length === 0) {
    token = randomBytes(32).toString("hex");
    process.env[TOKEN_ENV] = token;
  }
  return token;
}

/**
 * What our relay serves on a plain-HTTP GET so a losing generation can tell
 * its own relay from a stranger squatting the port. It must be a *secret*
 * proof, not a public marker: a foreign process could echo any known string
 * and thereby be handed the token-bearing URL. A hash of the token proves
 * knowledge of the token without disclosing it (one-way), and only our own
 * relay — sharing the process token — can produce the matching value.
 */
function ownershipProof(): string {
  return createHash("sha256").update(relayToken()).digest("hex");
}

/**
 * How the port question settled. "own": this process listens on it. "sibling":
 * another generation of this same relay does, proven by {@link ownershipProof}.
 * "dead": nothing trustworthy answers there.
 */
type RelayVerdict = "own" | "sibling" | "dead";

/** The pending or settled verdict; re-evaluated whenever it isn't "own". */
let readiness: Promise<RelayVerdict> | undefined;

/**
 * The websocket URL (with admission token) the panel should use, starting the
 * relay on first ask — or null when the port isn't ours. The verdict is
 * awaited before anything is handed out: returning the URL while the port
 * question is still open would hand the token to whatever is squatting there.
 */
export async function devVncRelayUrl(): Promise<string | null> {
  readiness ??= start();
  let verdict = await readiness;
  if (verdict !== "own") {
    // Only "own" is permanent (the listener lives as long as this process).
    // A sibling can exit and a squatter can free the port, so re-take or
    // re-verify it on every ask.
    readiness = start();
    verdict = await readiness;
  }
  if (verdict === "dead") return null;
  return `${RELAY_URL}?token=${relayToken()}`;
}

/** The relay admits only handshakes bearing the current process token. */
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
      void (async () => {
        // Resolve the upstream before completing the upgrade, mirroring the
        // deployed route: a desktop with nothing to connect to fails the
        // handshake instead of opening a socket that instantly drops.
        let upstreamUrl: string;
        try {
          const { connection } = await orgo.live();
          if (connection === null) {
            socket.destroy();
            return;
          }
          upstreamUrl = connection.websocketUrl;
        } catch {
          socket.destroy();
          return;
        }
        relay.handleUpgrade(request, socket, head, (client) => pipeVncSocket(client, upstreamUrl));
      })();
    });

    server.once("listening", () => resolve("own"));
    server.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        // Something already holds the port. Under `next dev` that is normally
        // an earlier generation of this same relay (module re-evaluation,
        // multiple workers), which serves the same desktop and is therefore
        // interchangeable — but only if it proves it.
        resolve(confirmOwnRelay());
        return;
      }
      console.warn(`[dev-vnc-relay] could not start on ${DEV_RELAY_PORT}: ${String(error)}`);
      resolve("dead");
    });
    server.listen(DEV_RELAY_PORT, "127.0.0.1");
  });
}

/** On a port clash, check whether the occupant is our own relay or a stranger. */
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
          `[dev-vnc-relay] port ${DEV_RELAY_PORT} is held by another process; ` +
            "the desktop view stays unavailable until it is free.",
        );
      }
      resolve(own ? "sibling" : "dead");
    };

    const proof = ownershipProof();
    const request = get({ host: "127.0.0.1", port: DEV_RELAY_PORT, path: "/" }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
        // The proof is a fixed-length hash; cap the read so a stranger
        // streaming forever can't balloon it (the deadline still bounds a
        // slow one).
        if (body.length > proof.length) {
          settle(false);
          request.destroy();
        }
      });
      response.on("end", () => settle(body.trim() === proof));
    });
    // Absolute deadline, not request.setTimeout: that measures socket
    // *inactivity*, so an occupant dribbling bytes under the interval would
    // reset it forever. A plain timer fires regardless and aborts the probe.
    deadline = setTimeout(() => {
      request.destroy();
      settle(false);
    }, PROBE_TIMEOUT_MS);
    request.on("error", () => settle(false));
  });
}
