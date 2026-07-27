// A local stand-in for the Orgo API, for exercising the cloud-desktop
// capability without an Orgo account. Speaks the surfaces the app touches,
// with the response shapes the real service actually answers with (the
// workspace list arrives under a `projects` key, connection fields only
// exist while a computer is running, screenshots are inline base64 PNG).
//
//   node scripts/orgo-stub.mjs                # listens on 127.0.0.1:4545
//   ORGO_API_BASE_URL=http://127.0.0.1:4545/api npm run dev
//
// Any bearer key is accepted except "bad", which answers 401 so the key
// verification path can be exercised. Lifecycle is simulated: a created or
// started computer spends a moment in `creating`/`starting` before landing on
// `running`; `stop` parks it back in `frozen` (what the real service calls an
// idle desktop). There is no VNC behind the stub, so the live view panel
// reaches its honest "nothing to watch" state rather than a live screen.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

const PORT = Number.parseInt(process.env.PORT ?? "4545", 10);
const BOOT_MS = 2_000;

/** @type {Map<string, {id: string, name: string, created_at: string, desktops: string[]}>} */
const workspaces = new Map();
/** @type {Map<string, any>} */
const computers = new Map();

function now() {
  return new Date().toISOString();
}

function settle(computer) {
  if (computer.settle_at !== undefined && Date.now() >= computer.settle_at) {
    computer.status = computer.settle_to;
    delete computer.settle_at;
    delete computer.settle_to;
  }
  return computer;
}

function transition(computer, through, to, ms = BOOT_MS) {
  computer.status = through;
  computer.settle_at = Date.now() + ms;
  computer.settle_to = to;
}

function computerView(computer) {
  settle(computer);
  const running = computer.status === "running";
  return {
    id: computer.id,
    name: computer.name,
    project_name: workspaces.get(computer.workspace_id)?.name,
    os: "linux",
    ram: computer.ram,
    cpu: computer.cpu,
    resolution: computer.resolution,
    status: computer.status,
    created_at: computer.created_at,
    // The connect surface only exists while the VM is up, like the real thing.
    ...(running
      ? {
          url: `http://127.0.0.1:${PORT}`,
          fly_instance_id: computer.instance_id,
          hostname: `127.0.0.1:${PORT}`,
          connection_url: `http://127.0.0.1:${PORT}/desktops/${computer.instance_id}`,
          vnc_password: computer.vnc_password,
        }
      : {}),
  };
}

function workspaceView(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    status: "active",
    created_at: workspace.created_at,
    desktops: workspace.desktops.map((id) => computerView(computers.get(id))),
  };
}

// -- A real PNG, drawn from scratch, so screenshots exercise the base64 path.

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** A desktop-looking frame: sky gradient, a "window", and a taskbar. */
function fakeScreenshotPng(width = 640, height = 400) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      let r = 24 + Math.round((y / height) * 40);
      let g = 39 + Math.round((y / height) * 60);
      let b = 68 + Math.round((y / height) * 90);
      const inWindow = x > 60 && x < width - 60 && y > 50 && y < height - 80;
      if (inWindow) {
        const titleBar = y < 78;
        r = titleBar ? 55 : 245;
        g = titleBar ? 65 : 246;
        b = titleBar ? 81 : 248;
      }
      if (y > height - 36) [r, g, b] = [17, 24, 39]; // taskbar
      const at = row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// -- Routing.

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  try {
    return text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method ?? "GET";
  const auth = request.headers.authorization ?? "";
  console.log(`[orgo-stub] ${method} ${path}`);

  if (!auth.startsWith("Bearer ") || auth === "Bearer bad") {
    return json(response, 401, { error: "Invalid API key" });
  }

  if (path === "/workspaces" && method === "GET") {
    // The list answers under the resource's former name, like the real API.
    return json(response, 200, { projects: [...workspaces.values()].map(workspaceView) });
  }
  if (path === "/workspaces" && method === "POST") {
    const body = await readBody(request);
    const workspace = {
      id: randomUUID(),
      name: typeof body.name === "string" ? body.name : "workspace",
      created_at: now(),
      desktops: [],
    };
    workspaces.set(workspace.id, workspace);
    return json(response, 200, { id: workspace.id, name: workspace.name, status: "active" });
  }

  const workspaceMatch = /^\/workspaces\/([^/]+)$/.exec(path);
  if (workspaceMatch !== null && method === "GET") {
    const workspace = workspaces.get(workspaceMatch[1]);
    if (workspace === undefined) return json(response, 404, { error: "Workspace not found" });
    return json(response, 200, workspaceView(workspace));
  }

  if (path === "/computers" && method === "POST") {
    const body = await readBody(request);
    const workspace = workspaces.get(body.workspace_id);
    if (workspace === undefined) return json(response, 404, { error: "Workspace not found" });
    const computer = {
      id: randomUUID(),
      instance_id: randomUUID().slice(0, 8),
      vnc_password: randomUUID().replaceAll("-", "").slice(0, 16),
      name: typeof body.name === "string" ? body.name : "computer",
      workspace_id: workspace.id,
      ram: body.ram ?? 4,
      cpu: body.cpu ?? 1,
      resolution: body.resolution ?? "1280x720x24",
      created_at: now(),
      status: "creating",
    };
    transition(computer, "creating", "running");
    computers.set(computer.id, computer);
    workspace.desktops.push(computer.id);
    return json(response, 200, computerView(computer));
  }

  const computerMatch = /^\/computers\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
  if (computerMatch !== null) {
    const computer = computers.get(computerMatch[1]);
    if (computer === undefined) return json(response, 404, { error: "Computer not found" });
    settle(computer);
    const action = computerMatch[2];

    if (action === undefined && method === "GET") return json(response, 200, computerView(computer));
    if (action === "start" && method === "POST") {
      if (computer.status !== "running") transition(computer, "starting", "running");
      return json(response, 200, { status: computer.status });
    }
    if (action === "stop" && method === "POST") {
      // An idle desktop reports `frozen` in the wild, not the documented `stopped`.
      transition(computer, "stopping", "frozen", 500);
      return json(response, 200, { status: computer.status });
    }
    if (action === "restart" && method === "POST") {
      computer.vnc_password = randomUUID().replaceAll("-", "").slice(0, 16);
      transition(computer, "restarting", "running");
      return json(response, 200, { status: computer.status });
    }
    if (action === "vnc-password" && method === "GET") {
      return json(response, 200, { password: computer.vnc_password });
    }
    if (action === "screenshot" && method === "GET") {
      if (computer.status !== "running") {
        return json(response, 400, { error: "instance not available" });
      }
      return json(response, 200, { image: fakeScreenshotPng().toString("base64") });
    }
    if (action === "bash" && method === "POST") {
      const body = await readBody(request);
      if (computer.status !== "running") {
        return json(response, 400, { error: "instance not available" });
      }
      return json(response, 200, { exit_code: 0, output: `[stub] ran: ${body.command ?? ""}` });
    }
  }

  if (path === "/v1/chat/completions" && method === "POST") {
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "x-thread-id": threadId,
    });
    const chunk = (content) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content } }], orgo: { thread_id: threadId } })}\n\n`;
    response.write(chunk("Done. "));
    response.write(chunk("This is the stub's computer-use result."));
    response.write("data: [DONE]\n\n");
    return response.end();
  }

  return json(response, 404, { error: `No stub route for ${method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[orgo-stub] listening at http://127.0.0.1:${PORT} (API base /api)`);
});
