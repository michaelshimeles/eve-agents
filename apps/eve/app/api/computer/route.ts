import { orgo, orgoConfigured, orgoKeySource, setAppOrgoKey, type LiveConnection } from "@/agent/lib/orgo";
import { requestOrigin } from "@/lib/app-url";
import { devVncRelayUrl } from "@/lib/dev-vnc-relay";
import { requireWebAuth } from "@/lib/web-auth";

// Backs the live desktop view: the same Orgo desktop the agent drives, exposed
// to the browser so the owner can watch it work and take the mouse when needed.
// Also manages the app-stored Orgo key (PUT to set, DELETE to clear), which is
// the no-Vercel-involved way to enable the feature; the key itself is verified
// against Orgo before it is saved and is never sent back out.
//
// The state response carries the desktop's VNC connection, which is full
// control of the machine, so this route is only as private as `requireWebAuth`
// makes it; lock that down alongside the chat itself.

interface ComputerView {
  name: string;
  status: string;
  liveViewUrl: string;
  specs: string | null;
  resolution: string | null;
}

function view(computer: {
  name: string;
  status: string;
  liveViewUrl: string;
  ram: number | null;
  cpu: number | null;
  resolution: string | null;
}): ComputerView {
  return {
    name: computer.name,
    status: computer.status,
    liveViewUrl: computer.liveViewUrl,
    specs:
      computer.ram === null || computer.cpu === null
        ? null
        : `${computer.ram} GB RAM / ${computer.cpu} CPU`,
    resolution: computer.resolution,
  };
}

// Waking or provisioning a desktop waits out a VM boot, which can outlive the
// platform's default function budget; give the route the full allowance.
export const maxDuration = 300;

/**
 * The connection the browser should use. Orgo's websockify proxy admits no
 * browser origin of ours — localhost included — and cuts them off after the
 * upgrade with 4001 "Origin not allowed", so the browser never talks to Orgo
 * directly. Deployed pages are pointed at the same-origin relay (./ws); dev,
 * where a route handler cannot upgrade a WebSocket, gets the loopback
 * sidecar relay instead. Both dial Orgo from the server, where no Origin
 * header is sent. The password rides along either way: the relays only
 * carry bytes, and VNC authenticates in-band.
 */
async function browserConnection(
  request: Request,
  connection: LiveConnection | null,
): Promise<LiveConnection | null> {
  if (connection === null) return null;
  if (process.env.NODE_ENV === "development") {
    // The sidecar's URL carries a per-process admission token; only this
    // same-origin response reveals it, so an attacker page cannot connect.
    // Null means the port isn't ours, so there is nothing safe to hand out.
    const websocketUrl = await devVncRelayUrl();
    return websocketUrl === null ? null : { websocketUrl, password: connection.password };
  }
  // Behind Vercel's proxy request.url carries an internal host, so the
  // public origin comes from the forwarded headers.
  const origin = new URL(requestOrigin(request));
  return {
    websocketUrl: `${origin.origin.replace(/^http/, "ws")}/api/computer/ws`,
    password: connection.password,
  };
}

async function currentState(
  request: Request,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const keySource = await orgoKeySource();
  if (keySource === null) return Response.json({ enabled: false, keySource: null, ...extra });

  const { computer, connection } = await orgo.live();
  if (computer === null) {
    return Response.json({ enabled: true, keySource, provisioned: false, ...extra });
  }
  return Response.json({
    enabled: true,
    keySource,
    provisioned: true,
    computer: view(computer),
    connection: await browserConnection(request, connection),
    ...extra,
  });
}

function failure(error: unknown): Response {
  return Response.json(
    { enabled: true, error: error instanceof Error ? error.message : "Orgo request failed." },
    { status: 502 },
  );
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  try {
    return await currentState(request);
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  if (!(await orgoConfigured())) return Response.json({ enabled: false, keySource: null });

  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action;
  if (action !== "start" && action !== "stop" && action !== "restart") {
    return new Response("Invalid action", { status: 400 });
  }

  try {
    // Waking provisions and waits for the VM — and restarts one that claims
    // to be running with nothing to connect to — so the follow-up read finds
    // the instance fields a VNC client needs.
    if (action === "start") await orgo.wake();
    if (action === "stop") await orgo.stop();
    if (action === "restart") await orgo.restart();
    return await currentState(request);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Save an app-managed key, checking it against Orgo first, then spin the
 * desktop up right away: the point of adding a key is to get a computer, so
 * one should exist (and be booting) by the time the response lands. The panel
 * polls the boot; a provisioning failure rides along without unsaving the key.
 */
export async function PUT(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { apiKey?: unknown } | null;
  const key = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (key.length === 0 || key.length > 200) {
    return Response.json({ error: "That does not look like an API key." }, { status: 400 });
  }

  try {
    await orgo.verifyKey(key);
    await setAppOrgoKey(key);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save the key." },
      { status: 400 },
    );
  }

  let provisionError: string | null = null;
  try {
    await orgo.provision();
  } catch (error) {
    provisionError = error instanceof Error ? error.message : "Could not start the desktop.";
  }

  try {
    return await currentState(request, provisionError === null ? {} : { error: provisionError });
  } catch (error) {
    return failure(error);
  }
}

/** Clear the app-managed key. A key from the environment is untouchable here. */
export async function DELETE(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  try {
    await setAppOrgoKey(null);
    return await currentState(request);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not remove the key." },
      { status: 400 },
    );
  }
}
