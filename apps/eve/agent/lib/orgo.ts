// A persistent cloud desktop for the agent, backed by Orgo (https://orgo.ai).
//
// Orgo rents full Linux VMs with a display, a browser, and a shell, reachable
// over HTTP. Two very different surfaces are used here:
//
//   - the per-action REST endpoints (bash, screenshot, lifecycle), which are
//     deterministic single calls, and
//   - the OpenAI-compatible /v1/chat/completions endpoint, where passing a
//     computer_id hands the desktop to a vision model that screenshots, clicks,
//     and types on its own until the instruction is done.
//
// The second one matters because eve tool results are text or JSON only, so a
// screenshot can never reach our own model as an image. Orgo's loop is the
// agent's eyes: it looks at the screen so we don't have to.
//
// Single-user agent, so there is exactly one long-lived desktop, discovered by
// name instead of persisted locally. Disk state survives stops, which is what
// makes logins and installed apps stick around between conversations.

import { agentName } from "./owner";
import { settingsStore } from "./settings-db";

const DEFAULT_API_BASE = "https://www.orgo.ai/api";
const DEFAULT_WORKSPACE_NAME = "eveclaw";

/** Where an app-managed key lives when the owner pastes one into the UI. */
const KEY_SETTING = "orgo-api-key";

/** Orgo's dotted model ids for the computer-use endpoint. */
const TASK_MODELS = {
  sonnet: "claude-sonnet-4.6",
  opus: "claude-opus-4.6",
} as const;

export type TaskModel = keyof typeof TASK_MODELS;

/** Statuses that settle on their own; poll instead of acting. */
const TRANSITIONAL = new Set(["creating", "starting", "restarting", "stopping"]);

/** Statuses a desktop cannot come back from without a person stepping in. */
const TERMINAL = new Set(["error", "deleting"]);

/** How long to let a start attempt take effect before trying again. */
const START_RETRY_MS = 10_000;

const READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * How many reads a desktop that just reported `running` gets to publish its
 * connect surface (instance id, VNC password) before it is treated as stale.
 * The fields usually arrive with the status, but a fresh boot can be a beat
 * behind, and restarting in that window would throw the boot away.
 */
const CONNECT_GRACE_POLLS = 8;

/**
 * How long one computer-use task may run. A vision loop can outlive the
 * platform's request budget, so the run is cut off well before that and handed
 * back with its thread id for the agent to resume.
 */
const DEFAULT_TASK_TIMEOUT_SECONDS = 240;

/** Largest screenshot worth inlining into a transcript as a data URL. */
const MAX_INLINE_SCREENSHOT_BYTES = 4 * 1024 * 1024;

export interface Computer {
  id: string;
  name: string;
  status: string;
  /** Orgo dashboard page: live view of the screen, and hands-on control. */
  liveViewUrl: string;
  ram: number | null;
  cpu: number | null;
  resolution: string | null;
}

export interface BashResult {
  exitCode: number | null;
  output: string;
}

/** What a VNC client needs to show the desktop's screen live. */
export interface LiveConnection {
  websocketUrl: string;
  /** Rotates on every restart, so it is read fresh alongside the URL. */
  password: string;
}

export interface TaskResult {
  /** `stopped_early` means the deadline cut the run off mid-task. */
  status: "completed" | "stopped_early";
  text: string;
  threadId: string | null;
  steps: number | null;
  costCents: number | null;
}

class OrgoError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OrgoError";
    this.status = status;
  }
}

/**
 * The key comes from the environment or, failing that, from the app settings
 * the owner can paste a key into. The environment wins when both exist: it is
 * deployment-level configuration, and a UI-saved leftover should not be able
 * to shadow it.
 */
export type OrgoKeySource = "env" | "app";

function envKey(): string | null {
  const key = process.env.ORGO_API_KEY?.trim();
  return key === undefined || key.length === 0 ? null : key;
}

export async function orgoKeySource(): Promise<OrgoKeySource | null> {
  if (envKey() !== null) return "env";
  return (await settingsStore.get(KEY_SETTING)) === null ? null : "app";
}

/** Whether this deployment has an Orgo key at all. Gates the whole capability. */
export async function orgoConfigured(): Promise<boolean> {
  return (await orgoKeySource()) !== null;
}

async function apiKey(): Promise<string> {
  const key = envKey() ?? (await settingsStore.get(KEY_SETTING));
  if (key === null) {
    throw new Error("No Orgo API key. Set ORGO_API_KEY, or add a key under Manage → Computer.");
  }
  return key;
}

/** Store or clear the app-managed key. `null` clears; the env key is untouched. */
export async function setAppOrgoKey(key: string | null): Promise<void> {
  if (key === null) await settingsStore.delete(KEY_SETTING);
  else await settingsStore.set(KEY_SETTING, key);
}

function apiBase(): string {
  const base = process.env.ORGO_API_BASE_URL?.trim();
  return (base !== undefined && base.length > 0 ? base : DEFAULT_API_BASE).replace(/\/+$/, "");
}

/** Orgo reports errors as `{error: "text"}` (REST) or `{error: {message}}` (chat). */
function errorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const { error } = parsed as { error?: unknown };
      if (typeof error === "string") return error;
      if (error !== null && typeof error === "object") {
        const { message } = error as { message?: unknown };
        if (typeof message === "string") return message;
      }
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return body.slice(0, 400);
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${await apiKey()}`,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new OrgoError(
      `Orgo ${init.method ?? "GET"} ${path} failed (${response.status}): ${errorMessage(text)}`,
      response.status,
    );
  }
  return (text.length > 0 ? JSON.parse(text) : null) as T;
}

interface RawComputer {
  id?: string;
  name?: string;
  status?: string;
  ram?: number;
  cpu?: number;
  resolution?: string;
  project_id?: string;
  instance_details?: { resolution?: string };
  /** Only populated while the VM is up; empty once it is frozen. */
  connection_url?: string;
  instance_id?: string;
  fly_instance_id?: string;
  vnc_password?: string;
}

/** Orgo's site origin, which serves both the dashboard and stored screenshots. */
function siteBase(): string {
  return apiBase().replace(/\/api$/, "");
}

/**
 * Where a person watches the desktop and takes over. Orgo's `url` field is
 * documented as a dashboard link but returns the VM's own noVNC endpoint
 * (`http://<ip>:<port>`), and there is no per-computer dashboard page, so link
 * the workspace the desktop lives in.
 */
function liveViewUrl(workspaceId: string | undefined): string {
  const base = siteBase();
  return workspaceId === undefined ? `${base}/workspaces` : `${base}/workspaces/${workspaceId}`;
}

function toComputer(raw: RawComputer, workspaceId?: string): Computer {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    status: raw.status ?? "unknown",
    liveViewUrl: liveViewUrl(workspaceId ?? raw.project_id),
    ram: raw.ram ?? null,
    cpu: raw.cpu ?? null,
    resolution: raw.resolution ?? raw.instance_details?.resolution ?? null,
  };
}

function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function workspaceName(): string {
  const configured = process.env.ORGO_WORKSPACE_NAME?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  // Builder-created deployments each get their own workspace.
  const project = process.env.EVE_PROJECT_NAME?.trim();
  return project !== undefined && project.length > 0 ? project : DEFAULT_WORKSPACE_NAME;
}

function computerName(): string {
  const configured = process.env.ORGO_COMPUTER_NAME?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  const named = sanitizeName(agentName());
  return named.length > 0 ? named : "agent";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface RawWorkspace {
  id?: string;
  name?: string;
  desktops?: RawComputer[];
}

/** The workspace holding the agent's desktop, created on demand. */
async function resolveWorkspaceId(
  options: { create: boolean; signal?: AbortSignal },
): Promise<string | null> {
  const pinned = process.env.ORGO_WORKSPACE_ID?.trim();
  if (pinned !== undefined && pinned.length > 0) return pinned;

  const name = workspaceName();
  const listed = await api<RawWorkspace[] | { workspaces?: RawWorkspace[]; projects?: RawWorkspace[] }>(
    "/workspaces",
    { signal: options.signal },
  );
  // Workspaces were called projects; the list still answers with that key.
  const workspaces = Array.isArray(listed) ? listed : (listed.workspaces ?? listed.projects ?? []);
  const existing = workspaces.find(
    (workspace) => workspace.name === name && typeof workspace.id === "string",
  );
  if (existing?.id !== undefined) return existing.id;

  // No workspace means no desktop either, so a lookup stops here rather than
  // leaving an empty workspace behind.
  if (!options.create) return null;

  const created = await api<{ id?: string }>("/workspaces", {
    method: "POST",
    body: { name },
    signal: options.signal,
  });
  if (created.id === undefined) throw new Error("Orgo created a workspace but returned no id.");
  return created.id;
}

/**
 * The agent's desktop identity, cached for the process. Ids are stable, so the
 * lookup runs once; a 404 drops it so the next call re-resolves. The workspace
 * rides along because reading one computer does not report which workspace it
 * belongs to, and the live view link needs it.
 */
let identity: { id: string; workspaceId: string } | undefined;

/**
 * Find the agent's desktop, optionally provisioning one. Reads that shouldn't
 * cost money (a status check, a stop) pass `create: false` and get `null`.
 */
async function resolveComputer(
  options: { create: boolean; signal?: AbortSignal },
): Promise<Computer | null> {
  const pinned = process.env.ORGO_COMPUTER_ID?.trim();
  if (pinned !== undefined && pinned.length > 0) {
    return toComputer(await api<RawComputer>(`/computers/${pinned}`, { signal: options.signal }));
  }

  if (identity !== undefined) {
    try {
      const known = await api<RawComputer>(`/computers/${identity.id}`, { signal: options.signal });
      return toComputer(known, identity.workspaceId);
    } catch (error) {
      if (!(error instanceof OrgoError) || error.status !== 404) throw error;
      identity = undefined;
    }
  }

  const workspaceId = await resolveWorkspaceId(options);
  if (workspaceId === null) return null;

  const name = computerName();
  const workspace = await api<RawWorkspace>(`/workspaces/${workspaceId}`, {
    signal: options.signal,
  });
  const match = (workspace.desktops ?? []).find((desktop) => desktop.name === name);
  if (match?.id !== undefined) {
    identity = { id: match.id, workspaceId };
    return toComputer(match, workspaceId);
  }

  if (!options.create) return null;

  const created = await api<RawComputer>("/computers", {
    method: "POST",
    body: {
      workspace_id: workspaceId,
      name,
      ram: positiveInt(process.env.ORGO_COMPUTER_RAM, 4),
      cpu: positiveInt(process.env.ORGO_COMPUTER_CPU, 1),
      ...(process.env.ORGO_COMPUTER_RESOLUTION?.trim()
        ? { resolution: process.env.ORGO_COMPUTER_RESOLUTION.trim() }
        : {}),
    },
    signal: options.signal,
  });
  if (created.id === undefined) throw new Error("Orgo created a computer but returned no id.");
  identity = { id: created.id, workspaceId };
  return toComputer(created, workspaceId);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new Error("Cancelled.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("Cancelled."));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Bring the desktop to `running`: wait out any transition, wake it otherwise.
 * An idle desktop is normal — auto-stop and manual stops both leave the disk
 * intact — so acting on one should just work.
 *
 * Anything that is neither running nor mid-transition is treated as needing a
 * start. A stopped desktop reports `frozen` rather than the documented
 * `stopped`, and matching on one exact word would strand it there forever.
 */
async function ensureRunning(computer: Computer, signal?: AbortSignal): Promise<Computer> {
  let current = computer;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let startedAt = 0;

  while (Date.now() < deadline) {
    if (current.status === "running") return current;
    if (TERMINAL.has(current.status)) {
      throw new Error(
        `Desktop "${current.name}" is ${current.status}; it needs attention in the Orgo dashboard.`,
      );
    }
    if (!TRANSITIONAL.has(current.status) && Date.now() - startedAt > START_RETRY_MS) {
      startedAt = Date.now();
      await api(`/computers/${current.id}/start`, { method: "POST", signal });
    }
    await sleep(POLL_INTERVAL_MS, signal);
    const refreshed = await api<RawComputer>(`/computers/${current.id}`, { signal });
    // Reading one computer does not say which workspace it is in, so carry the
    // live view link forward instead of degrading it to the workspace index.
    current = { ...toComputer(refreshed), liveViewUrl: current.liveViewUrl };
  }

  throw new Error(
    `Desktop "${current.name}" did not reach running within ${READY_TIMEOUT_MS / 1000}s (status: ${current.status}).`,
  );
}

/** The desktop, provisioned and running, ready to be acted on. */
async function activeComputer(signal?: AbortSignal): Promise<Computer> {
  const computer = await resolveComputer({ create: true, signal });
  if (computer === null) throw new Error("Orgo did not return a computer.");
  return await ensureRunning(computer, signal);
}

/**
 * A VM reports `running` a little before its desktop agent accepts calls, so
 * the first action after a boot can land in that window: Orgo answers 400
 * ("instance not available") or 503 ("could not reach the desktop"). Both mean
 * the action never ran, which makes it safe to repeat.
 *
 * Other 5xx responses are only retried for reads. They cover a killed or
 * half-spawned process, so replaying a shell command could apply its side
 * effects twice.
 */
function unreachable(error: unknown): boolean {
  return error instanceof OrgoError && (error.status === 400 || error.status === 503);
}

async function withRetry<T>(
  attempt: () => Promise<T>,
  options: { signal?: AbortSignal; retryServerErrors?: boolean } = {},
): Promise<T> {
  const delays = [1_000, 3_000, 6_000];
  for (let index = 0; ; index++) {
    try {
      return await attempt();
    } catch (error) {
      const retriable =
        unreachable(error) ||
        (options.retryServerErrors === true && error instanceof OrgoError && error.status >= 500);
      if (!retriable || index >= delays.length) throw error;
      await sleep(delays[index], options.signal);
    }
  }
}

/**
 * The desktop plus, when it is up, everything a VNC client needs to watch the
 * screen. A frozen VM has no instance behind it yet — Orgo blanks the
 * connection fields — so the connection is null until it is woken.
 */
async function liveState(
  signal?: AbortSignal,
): Promise<{ computer: Computer | null; connection: LiveConnection | null }> {
  const computer = await resolveComputer({ create: false, signal });
  if (computer === null || computer.status !== "running") return { computer, connection: null };

  // Discovery may have come from the workspace listing, which carries an
  // encrypted password and no instance id, so read the computer itself.
  const raw = await api<RawComputer>(`/computers/${computer.id}`, { signal });
  const instanceId = raw.instance_id ?? raw.fly_instance_id;
  const base =
    raw.connection_url !== undefined && raw.connection_url.length > 0
      ? raw.connection_url
      : instanceId === undefined
        ? null
        : `${siteBase()}/desktops/${instanceId}`;
  if (base === null) return { computer, connection: null };

  const password =
    raw.vnc_password ??
    (await api<{ password?: string }>(`/computers/${computer.id}/vnc-password`, { signal }))
      .password;
  if (password === undefined) return { computer, connection: null };

  return {
    computer,
    connection: {
      websocketUrl: `${base.replace(/^http/, "ws")}/ws/websockify?token=${encodeURIComponent(password)}`,
      password,
    },
  };
}

/**
 * {@link liveState}, but a desktop that says `running` with no connection yet
 * gets {@link CONNECT_GRACE_POLLS} re-reads to publish it before the missing
 * connection is taken at face value.
 */
async function settledLiveState(
  signal?: AbortSignal,
): Promise<{ computer: Computer | null; connection: LiveConnection | null }> {
  let live = await liveState(signal);
  for (
    let poll = 0;
    live.connection === null && live.computer?.status === "running" && poll < CONNECT_GRACE_POLLS;
    poll++
  ) {
    await sleep(POLL_INTERVAL_MS, signal);
    live = await liveState(signal);
  }
  return live;
}

export const orgo = {
  /** Check a candidate key against Orgo before storing it. Throws when bad. */
  async verifyKey(key: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${apiBase()}/workspaces`, {
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    if (!response.ok) {
      throw new OrgoError(
        response.status === 401
          ? "Orgo rejected that key."
          : `Orgo answered ${response.status} while checking the key.`,
        response.status,
      );
    }
  },

  /** Current desktop, or `null` when none has been provisioned yet. */
  async status(signal?: AbortSignal): Promise<Computer | null> {
    return await resolveComputer({ create: false, signal });
  },

  /** Provision when missing, then make sure it is running. */
  async start(signal?: AbortSignal): Promise<Computer> {
    return await activeComputer(signal);
  },

  /**
   * Make sure a desktop exists and is on its way up, without waiting for it
   * to finish booting. Saving an API key calls this so the desktop becomes
   * real the moment the key lands — visible in the panel and in the Orgo
   * dashboard — while the UI polls the status instead of holding one request
   * open across the whole boot.
   */
  async provision(signal?: AbortSignal): Promise<Computer> {
    const computer = await resolveComputer({ create: true, signal });
    if (computer === null) throw new Error("Orgo did not return a computer.");
    const settled =
      computer.status === "running" ||
      TRANSITIONAL.has(computer.status) ||
      TERMINAL.has(computer.status);
    if (settled) return computer;
    await api(`/computers/${computer.id}/start`, { method: "POST", signal });
    return { ...computer, status: "starting" };
  },

  /**
   * Bring the desktop up *and watchable*. A desktop can report `running`
   * while there is nothing behind it to connect to — a record gone stale
   * after a dashboard delete, or a boot that lost its instance — and starting
   * it again is a no-op in that state. Waking is the owner's explicit "show
   * me the screen", so after a grace period (a fresh boot can publish its
   * connection fields a beat after its status) force a restart: it keeps the
   * disk and comes back with a fresh instance and fresh VNC credentials.
   */
  async wake(
    signal?: AbortSignal,
  ): Promise<{ computer: Computer; connection: LiveConnection | null }> {
    const computer = await activeComputer(signal);
    let live = await settledLiveState(signal);
    if (live.connection !== null) return { computer: live.computer ?? computer, connection: live.connection };

    await api(`/computers/${computer.id}/restart`, { method: "POST", signal });
    const restarted = await ensureRunning({ ...computer, status: "restarting" }, signal);
    live = await settledLiveState(signal);
    return { computer: live.computer ?? restarted, connection: live.connection };
  },

  async stop(signal?: AbortSignal): Promise<Computer | null> {
    const computer = await resolveComputer({ create: false, signal });
    if (computer === null) return null;
    // Already idle (Orgo calls that `frozen`) or on its way there.
    const running = computer.status === "running" || computer.status === "starting";
    if (!running) return computer;
    await api(`/computers/${computer.id}/stop`, { method: "POST", signal });
    return { ...computer, status: "stopping" };
  },

  async restart(signal?: AbortSignal): Promise<Computer | null> {
    const computer = await resolveComputer({ create: false, signal });
    if (computer === null) return null;
    // Restarting something that is already down is just waking it.
    if (computer.status !== "running") return await ensureRunning(computer, signal);
    await api(`/computers/${computer.id}/restart`, { method: "POST", signal });
    return { ...computer, status: "restarting" };
  },

  /** See {@link liveState}: the desktop plus what a VNC client needs to watch it. */
  async live(
    signal?: AbortSignal,
  ): Promise<{ computer: Computer | null; connection: LiveConnection | null }> {
    return await liveState(signal);
  },

  async bash(
    command: string,
    options: { timeoutSeconds?: number; signal?: AbortSignal } = {},
  ): Promise<BashResult & { computer: Computer }> {
    const computer = await activeComputer(options.signal);
    const result = await withRetry(
      () =>
        api<{ output?: string; exit_code?: number }>(`/computers/${computer.id}/bash`, {
          method: "POST",
          body: {
            command,
            ...(options.timeoutSeconds === undefined ? {} : { timeout: options.timeoutSeconds }),
          },
          signal: options.signal,
        }),
      { signal: options.signal },
    );
    return { computer, exitCode: result.exit_code ?? null, output: result.output ?? "" };
  },

  /**
   * Capture the screen. Orgo stores the image and answers with a path under
   * its own origin (publicly readable), though the documented shape is an
   * absolute URL or inline base64. Normalize to something the owner can see
   * in chat: a URL when Orgo stored the image, otherwise a data URL the chat
   * UI renders inline. `inlineBytes` reports an inline payload too large to
   * carry in a transcript.
   */
  async screenshot(signal?: AbortSignal): Promise<{
    computer: Computer;
    imageUrl: string | null;
    imageDataUrl: string | null;
    inlineBytes: number | null;
  }> {
    const computer = await activeComputer(signal);
    const result = await withRetry(
      () => api<{ image?: string }>(`/computers/${computer.id}/screenshot`, { signal }),
      { signal, retryServerErrors: true },
    );

    const image = result.image ?? "";
    const none = { computer, imageUrl: null, imageDataUrl: null, inlineBytes: null };
    if (/^https?:\/\//.test(image)) return { ...none, imageUrl: image };
    if (image.startsWith("/")) return { ...none, imageUrl: `${siteBase()}${image}` };
    if (image.length === 0) return none;

    const base64 = image.startsWith("data:") ? (image.split(",", 2)[1] ?? "") : image;
    const bytes = Math.floor((base64.length * 3) / 4);
    // Screenshots ride along in the session transcript, so a runaway payload
    // is dropped rather than ballooning every later load of the thread.
    if (bytes > MAX_INLINE_SCREENSHOT_BYTES) return { ...none, inlineBytes: bytes };
    return { ...none, imageDataUrl: `data:image/png;base64,${base64}` };
  },

  /**
   * Hand the desktop to Orgo's computer-use model and let it work until the
   * instruction is done. Streamed because the thread id arrives in a response
   * header before the run finishes: a task cut short by the deadline can still
   * be resumed from the same thread.
   */
  async task(input: {
    instruction: string;
    threadId?: string;
    model?: TaskModel;
    maxSteps?: number;
    signal?: AbortSignal;
  }): Promise<TaskResult & { computer: Computer }> {
    const computer = await activeComputer(input.signal);

    const controller = new AbortController();
    const stopOnCancel = (): void => controller.abort();
    input.signal?.addEventListener("abort", stopOnCancel, { once: true });
    const timeoutSeconds = positiveInt(
      process.env.ORGO_TASK_TIMEOUT_SECONDS,
      DEFAULT_TASK_TIMEOUT_SECONDS,
    );
    const deadline = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);

    let text = "";
    let threadId: string | null = input.threadId ?? null;
    let steps: number | null = null;
    let costCents: number | null = null;

    try {
      const response = await fetch(`${apiBase()}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await apiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: TASK_MODELS[input.model ?? "sonnet"],
          computer_id: computer.id,
          messages: [{ role: "user", content: input.instruction }],
          stream: true,
          ...(input.maxSteps === undefined ? {} : { max_steps: input.maxSteps }),
          ...(input.threadId === undefined ? {} : { thread_id: input.threadId }),
        }),
        signal: controller.signal,
      });

      threadId = response.headers.get("x-thread-id") ?? threadId;

      if (!response.ok) {
        throw new OrgoError(
          `Orgo computer task failed (${response.status}): ${errorMessage(await response.text())}`,
          response.status,
        );
      }
      if (response.body === null) throw new Error("Orgo returned an empty computer-task stream.");

      for await (const event of sseEvents(response.body)) {
        if (event === "[DONE]") break;
        const chunk = parseChunk(event);
        if (chunk === null) continue;
        text += chunk.content;
        threadId = chunk.threadId ?? threadId;
        steps = chunk.steps ?? steps;
        costCents = chunk.costCents ?? costCents;
      }

      return {
        computer,
        status: "completed",
        text: text.trim(),
        threadId,
        steps,
        costCents,
      };
    } catch (error) {
      // Our own deadline aborted the stream; the caller's cancellation is real.
      const cutShort =
        controller.signal.aborted &&
        input.signal?.aborted !== true &&
        error instanceof Error &&
        error.name === "AbortError";
      if (!cutShort) throw error;
      return {
        computer,
        status: "stopped_early",
        text: text.trim(),
        threadId,
        steps,
        costCents,
      };
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", stopOnCancel);
    }
  },
};

/** Yield each SSE `data:` payload from a response body. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
      newline = buffer.indexOf("\n");
    }
  }

  const rest = buffer.trim();
  if (rest.startsWith("data:")) yield rest.slice(5).trim();
}

interface ChunkFields {
  content: string;
  threadId: string | null;
  steps: number | null;
  costCents: number | null;
}

/**
 * Pull the text delta out of an OpenAI-shaped chunk. Orgo's run metadata is
 * documented on the non-streaming response, so read it opportunistically and
 * fall back to nothing when a chunk omits it.
 */
function parseChunk(payload: string): ChunkFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const { choices, orgo: meta } = parsed as {
    choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[];
    orgo?: { thread_id?: unknown; steps?: unknown; cost_cents?: unknown };
  };

  const choice = choices?.[0];
  const raw = choice?.delta?.content ?? choice?.message?.content;

  return {
    content: typeof raw === "string" ? raw : "",
    threadId: typeof meta?.thread_id === "string" ? meta.thread_id : null,
    steps: typeof meta?.steps === "number" ? meta.steps : null,
    costCents: typeof meta?.cost_cents === "number" ? meta.cost_cents : null,
  };
}
