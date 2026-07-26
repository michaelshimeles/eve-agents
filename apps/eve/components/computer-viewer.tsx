"use client";

import { Badge, Button, Input, Loader } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CursorClickIcon,
  EyeIcon,
  PowerIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AGENT_NAME } from "@/lib/identity";
import { cn } from "@/lib/utils";

// Live view of the cloud desktop the agent drives, over VNC. Watching the
// screen while a computer task runs is the only way to see what the agent is
// actually doing out there, and taking the mouse is the escape hatch for the
// things it should not do itself - signing in, mainly.
//
// noVNC talks to Orgo's websockify endpoint straight from the browser, since a
// WebSocket cannot be proxied through a serverless route. The token comes from
// /api/computer and is scoped to this one desktop.

interface ComputerInfo {
  name: string;
  status: string;
  liveViewUrl: string;
  specs: string | null;
  resolution: string | null;
}

interface ComputerState {
  enabled: boolean;
  keySource?: "env" | "app" | null;
  provisioned?: boolean;
  computer?: ComputerInfo;
  connection?: { websocketUrl: string; password: string } | null;
  error?: string;
}

/** The header button and manage tab key off this; tell them when it flips. */
function announceFeatureChange(): void {
  window.dispatchEvent(new Event("eve:features-changed"));
}

/** Statuses that settle on their own; the panel polls until they do. */
const TRANSITIONAL_STATUSES = new Set(["creating", "starting", "restarting", "stopping"]);

/**
 * A VM can report `running` a beat before its connection details exist; poll
 * a few times before concluding there is genuinely nothing to watch.
 */
const MAX_BLIND_POLLS = 5;

const POLL_INTERVAL_MS = 2_000;

/**
 * How many times a dropped VNC session re-fetches the state and reconnects
 * before parking on idle. A restart rotates the VNC password, so an open
 * panel's connection info goes stale the moment the desktop reboots; a
 * fresh read is usually all it takes to get the screen back.
 */
const MAX_RECONNECTS = 3;

type Phase = "loading" | "connecting" | "live" | "idle" | "waking" | "missing" | "off" | "error";

type Rfb = InstanceType<typeof import("@novnc/novnc").default>;

export function ComputerViewer({ className }: { className?: string }) {
  const [state, setState] = useState<ComputerState | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [busy, setBusy] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<Rfb | null>(null);
  // Consecutive "running but nothing to connect to" reads; see MAX_BLIND_POLLS.
  const blindPollsRef = useRef(0);
  // Consecutive dropped VNC sessions; see MAX_RECONNECTS.
  const reconnectsRef = useRef(0);

  const load = useCallback(async (): Promise<ComputerState | null> => {
    try {
      const response = await fetch("/api/computer");
      const body = (await response.json()) as ComputerState;
      setState(body);
      return body;
    } catch {
      setState({ enabled: true, error: "Could not reach the desktop." });
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A desktop in motion settles on its own: keep reading until it does. Also
  // give a freshly running desktop a few reads to hand over its connection
  // details before declaring there is nothing to watch.
  useEffect(() => {
    if (state === null || !state.enabled || state.error !== undefined) return;
    const status = state.computer?.status;
    const transitional = status !== undefined && TRANSITIONAL_STATUSES.has(status);
    if (transitional) blindPollsRef.current = 0;
    const blind =
      status === "running" &&
      (state.connection ?? null) === null &&
      blindPollsRef.current < MAX_BLIND_POLLS;
    if (!transitional && !blind) return;
    if (blind) blindPollsRef.current += 1;
    const timer = setTimeout(() => void load(), POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [state, load]);

  // Connect once a running desktop hands back a websocket, and tear the
  // session down whenever it goes away.
  useEffect(() => {
    if (state === null) return;
    if (!state.enabled) {
      setPhase("off");
      return;
    }
    if (state.error !== undefined) {
      // A failed re-read mid-reconnect (a network blip, a transient API
      // error) is the same kind of hiccup as a dropped session: spend a
      // retry on it instead of stranding the panel on the error screen
      // while attempts remain. Errors outside a reconnect show right away.
      if (reconnectsRef.current > 0 && reconnectsRef.current < MAX_RECONNECTS) {
        reconnectsRef.current += 1;
        setPhase("connecting");
        const retry = setTimeout(() => void load(), 1_500);
        return () => clearTimeout(retry);
      }
      setPhase("error");
      return;
    }
    if (state.provisioned !== true) {
      setPhase("missing");
      return;
    }

    const status = state.computer?.status;
    const connection = state.connection;
    if (connection === null || connection === undefined) {
      const settling =
        (status !== undefined && TRANSITIONAL_STATUSES.has(status)) ||
        (status === "running" && blindPollsRef.current < MAX_BLIND_POLLS);
      setPhase(settling ? "waking" : "idle");
      return;
    }
    blindPollsRef.current = 0;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setPhase("connecting");

    void (async () => {
      // noVNC touches the DOM on import, so it only loads in the browser.
      const { default: RFB } = await import("@novnc/novnc");
      const screen = screenRef.current;
      if (cancelled || screen === null) return;

      const rfb = new RFB(screen, connection.websocketUrl, {
        credentials: { password: connection.password },
        wsProtocols: ["binary"],
      });
      rfb.viewOnly = true;
      rfb.scaleViewport = true;
      rfb.background = "transparent";
      rfb.addEventListener("connect", () => {
        if (cancelled) return;
        reconnectsRef.current = 0;
        setPhase("live");
      });
      rfb.addEventListener("disconnect", () => {
        if (cancelled) return;
        // The session dropped on its own. A restart rotates the VNC password,
        // so the connection info in hand may simply be stale: re-read the
        // state (which re-triggers this effect) before giving up on the
        // screen. Repeated failures park on idle rather than looping.
        if (reconnectsRef.current < MAX_RECONNECTS) {
          reconnectsRef.current += 1;
          setPhase("connecting");
          retryTimer = setTimeout(() => void load(), 1_500);
          return;
        }
        setPhase("idle");
      });
      rfbRef.current = rfb;
    })();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, [state, load]);

  useEffect(() => {
    if (rfbRef.current !== null) rfbRef.current.viewOnly = !interactive;
  }, [interactive]);

  async function act(action: "start" | "stop" | "restart"): Promise<void> {
    setBusy(true);
    setInteractive(false);
    // A deliberate action gets a fresh reconnect budget.
    reconnectsRef.current = 0;
    try {
      const response = await fetch("/api/computer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setState((await response.json()) as ComputerState);
    } catch {
      setState({ enabled: true, error: "Could not reach the desktop." });
    } finally {
      setBusy(false);
    }
  }

  const computer = state?.computer;
  const running = phase === "live" || phase === "connecting";

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={phase === "live" ? "success" : "secondary"}>
          {phase === "live"
            ? "live"
            : phase === "connecting"
              ? "connecting"
              : (computer?.status ?? "no desktop")}
        </Badge>
        {computer !== undefined && (
          <span className="text-sm text-kumo-subtle">
            {computer.name}
            {computer.specs === null ? "" : ` · ${computer.specs}`}
            {computer.resolution === null ? "" : ` · ${computer.resolution}`}
          </span>
        )}
        <div className="ms-auto flex items-center gap-2">
          {phase === "live" && (
            <Button
              variant={interactive ? "primary" : "secondary"}
              size="sm"
              onClick={() => setInteractive((value) => !value)}
            >
              {interactive ? <CursorClickIcon /> : <EyeIcon />}
              {interactive ? "You have control" : "Take control"}
            </Button>
          )}
          {phase === "idle" || phase === "missing" ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void act("start")}>
              {busy ? <Loader size={14} /> : <PowerIcon />}
              {phase === "missing" ? "Create desktop" : "Wake it up"}
            </Button>
          ) : null}
          {running && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act("stop")}>
              <PowerIcon />
              Stop
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              reconnectsRef.current = 0;
              void load();
            }}
          >
            <ArrowClockwiseIcon />
          </Button>
        </div>
      </div>

      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg bg-kumo-canvas ring ring-kumo-hairline">
        <div ref={screenRef} className="absolute inset-0" />
        {phase !== "live" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            {phase === "loading" || phase === "connecting" ? (
              <Loader size={20} />
            ) : phase === "waking" ? (
              <>
                <Loader size={20} />
                <p className="max-w-sm text-sm text-kumo-subtle">
                  The desktop is starting up. Hang on.
                </p>
              </>
            ) : phase === "off" ? (
              <KeyForm onSaved={setState} />
            ) : (
              <p className="max-w-sm text-sm text-kumo-subtle">
                {phase === "missing"
                  ? `${AGENT_NAME} does not have a desktop yet. Create one to watch her work.`
                  : phase === "error"
                    ? (state?.error ?? "Something went wrong.")
                    : computer?.status === "running"
                      ? "The desktop says it is running, but there is nothing to watch. Waking it restarts the machine with its files intact."
                      : "The desktop is asleep. Its files and logins are intact - wake it to watch."}
              </p>
            )}
          </div>
        )}
      </div>

      {computer !== undefined && (
        <p className="text-xs text-kumo-subtle">
          {interactive
            ? "Your clicks and keys go straight to the desktop. Switch back to watching when you are done."
            : "Watching only - clicks and keys are ignored."}{" "}
          <a
            href={computer.liveViewUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline"
          >
            Open in Orgo
            <ArrowSquareOutIcon />
          </a>
        </p>
      )}

      {state?.enabled === true && state.keySource === "app" && (
        <RemoveKeyRow onRemoved={setState} />
      )}
    </div>
  );
}

/**
 * First-run setup: paste an Orgo key here instead of touching deployment env
 * vars. The server checks the key against Orgo before keeping it, and it is
 * never sent back to the browser afterwards.
 */
function KeyForm({ onSaved }: { onSaved: (state: ComputerState) => void }) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (draft.trim().length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/computer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: draft.trim() }),
      });
      const body = (await response.json()) as ComputerState & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not save the key.");
        return;
      }
      onSaved(body);
      announceFeatureChange();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-sm text-kumo-subtle">
        Give {AGENT_NAME} a computer: paste an{" "}
        <a
          href="https://www.orgo.ai/start"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Orgo API key
        </a>{" "}
        and it is stored in this app - no deployment settings involved.
      </p>
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          type="password"
          value={draft}
          placeholder="sk_live_..."
          aria-label="Orgo API key"
          className="flex-1"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={saving || draft.trim().length === 0}
        >
          {saving ? <Loader size={14} /> : "Save"}
        </Button>
      </div>
      {error !== null && <p className="text-xs text-kumo-danger">{error}</p>}
    </form>
  );
}

/** Clearing the app-stored key turns the whole capability off; ask twice. */
function RemoveKeyRow({ onRemoved }: { onRemoved: (state: ComputerState) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove(): Promise<void> {
    setBusy(true);
    try {
      const response = await fetch("/api/computer", { method: "DELETE" });
      const body = (await response.json()) as ComputerState;
      if (response.ok) {
        onRemoved(body);
        announceFeatureChange();
      }
    } catch {
      // The row stays; the next click can retry.
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <p className="text-xs text-kumo-subtle">
      The Orgo API key is stored in this app.{" "}
      {confirming ? (
        <>
          Removing it disables {AGENT_NAME}&rsquo;s computer.{" "}
          <button
            type="button"
            className="text-kumo-danger underline"
            disabled={busy}
            onClick={() => void remove()}
          >
            Remove it
          </button>{" "}
          <button type="button" className="underline" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </>
      ) : (
        <button type="button" className="underline" onClick={() => setConfirming(true)}>
          Remove key
        </button>
      )}
    </p>
  );
}
