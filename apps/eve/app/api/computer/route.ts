import { orgo, orgoConfigured, orgoKeySource, setAppOrgoKey } from "@/agent/lib/orgo";
import { requireWebAuth } from "@/lib/web-auth";

// Backs the live desktop view: the same Orgo desktop the agent drives, exposed
// to the browser so the owner can watch it work and take the mouse when needed.
// Also manages the app-stored Orgo key (PUT to set, DELETE to clear), which is
// the no-Vercel-involved way to enable the feature; the key itself is verified
// against Orgo before it is saved and is never sent back out.
//
// The state response carries the desktop's VNC token, because the browser
// talks to Orgo's websockify endpoint directly — a WebSocket cannot be proxied
// through a serverless route. That token is full control of the machine, so
// this route is only as private as `requireWebAuth` makes it; lock that down
// alongside the chat itself.

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

async function currentState(): Promise<Response> {
  const keySource = await orgoKeySource();
  if (keySource === null) return Response.json({ enabled: false, keySource: null });

  const { computer, connection } = await orgo.live();
  if (computer === null) return Response.json({ enabled: true, keySource, provisioned: false });
  return Response.json({
    enabled: true,
    keySource,
    provisioned: true,
    computer: view(computer),
    connection,
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
    return await currentState();
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
    // start provisions and waits for the VM, so the follow-up read finds the
    // instance fields a VNC client needs.
    if (action === "start") await orgo.start();
    if (action === "stop") await orgo.stop();
    if (action === "restart") await orgo.restart();
    return await currentState();
  } catch (error) {
    return failure(error);
  }
}

/** Save an app-managed key, checking it against Orgo first. */
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
    return await currentState();
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save the key." },
      { status: 400 },
    );
  }
}

/** Clear the app-managed key. A key from the environment is untouchable here. */
export async function DELETE(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  try {
    await setAppOrgoKey(null);
    return await currentState();
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not remove the key." },
      { status: 400 },
    );
  }
}
