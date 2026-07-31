"use client";

import { Badge, Button, Dialog, LinkButton, Loader } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  DownloadSimpleIcon,
  LaptopIcon,
  LinkIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

interface LocalDevice {
  id: string;
  name: string;
  platform: string;
  architecture: string;
  pairedAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

interface LocalComputerState {
  databaseConfigured: boolean;
  device: LocalDevice | null;
  directConfigured: boolean;
  pairingAvailable: boolean;
  downloadUrl: string;
  error?: string;
}

const POLL_INTERVAL_MS = 5_000;

function formatLastSeen(value: string | null): string {
  if (value === null) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function LocalComputerPanel() {
  const [state, setState] = useState<LocalComputerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/local-computer", { cache: "no-store" });
      const body = (await response.json()) as LocalComputerState;
      if (!response.ok) throw new Error(body.error ?? "Could not read Ruth Local.");
      setState(body);
    } catch (error) {
      setState({
        databaseConfigured: false,
        device: null,
        directConfigured: false,
        pairingAvailable: false,
        downloadUrl: "/api/local-computer/download",
        error:
          error instanceof Error ? error.message : "Could not read Ruth Local.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function connect(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/local-computer", { method: "POST" });
      const body = (await response.json()) as { pairUrl?: string; error?: string };
      if (!response.ok || body.pairUrl === undefined) {
        throw new Error(body.error ?? "Could not create a secure pairing link.");
      }
      window.location.href = body.pairUrl;
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not connect Ruth Local.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/local-computer", { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Could not disconnect this Mac.");
      }
      setDisconnectOpen(false);
      await load();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not disconnect this Mac.",
      );
    } finally {
      setBusy(false);
    }
  }

  const device = state?.device ?? null;
  const manuallyConfigured = state?.directConfigured === true && device === null;

  return (
    <section className="rounded-xl border border-kumo-hairline bg-kumo-elevated p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-kumo-tint">
          <LaptopIcon className="size-5 text-kumo-subtle" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-balance text-sm font-semibold">Your Mac</h2>
            {device !== null && (
              <Badge variant={device.online ? "success" : "secondary"}>
                {device.online ? "connected" : "offline"}
              </Badge>
            )}
            {manuallyConfigured && <Badge variant="success">connected manually</Badge>}
          </div>

          {state === null ? (
            <div className="mt-3 flex items-center gap-2 text-sm text-kumo-subtle">
              <Loader size={14} />
              Checking connection…
            </div>
          ) : state.error !== undefined ? (
            <p className="mt-2 text-pretty text-sm text-kumo-danger">{state.error}</p>
          ) : device !== null ? (
            <div className="mt-1">
              <p className="text-pretty text-sm text-kumo-subtle">
                {device.name} · {device.architecture === "arm64" ? "Apple silicon" : "Intel"}
              </p>
              <p className="mt-1 text-xs text-kumo-subtle">
                Last seen {formatLastSeen(device.lastSeenAt)}
              </p>
            </div>
          ) : manuallyConfigured ? (
            <p className="mt-1 text-pretty text-sm text-kumo-subtle">
              Ruth is using the operator-configured direct bridge.
            </p>
          ) : (
            <p className="mt-1 max-w-xl text-pretty text-sm text-kumo-subtle">
              Download the small Ruth Local helper, open it once, then connect.
              It runs in the menu bar and starts automatically when you log in.
            </p>
          )}
        </div>

        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 pl-12 sm:w-auto sm:pl-0">
          {device === null && !manuallyConfigured ? (
            <>
              <LinkButton
                href={state?.downloadUrl ?? "/api/local-computer/download"}
                variant="primary"
                size="sm"
                download
              >
                <DownloadSimpleIcon />
                Download for Mac
              </LinkButton>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || state?.pairingAvailable !== true}
                onClick={() => void connect()}
              >
                {busy ? <Loader size={14} /> : <LinkIcon />}
                Connect
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                aria-label="Refresh local computer status"
                disabled={busy}
                onClick={() => void load()}
              >
                <ArrowClockwiseIcon />
              </Button>
              {device !== null && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setDisconnectOpen(true)}
                >
                  Disconnect
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {device === null &&
        !manuallyConfigured &&
        state !== null &&
        !state.pairingAvailable && (
          <p className="mt-3 text-pretty text-sm text-kumo-danger">
            One-click pairing needs this deployment&apos;s database connection.
          </p>
        )}
      {actionError !== null && (
        <p className="mt-3 text-pretty text-sm text-kumo-danger">{actionError}</p>
      )}
      {device === null && !manuallyConfigured && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-kumo-tint px-3 py-2.5">
          <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-kumo-subtle" aria-hidden />
          <p className="text-pretty text-xs text-kumo-subtle">
            macOS will still ask you to approve Accessibility and Screen Recording.
            Ruth cannot grant those permissions for itself.
          </p>
        </div>
      )}

      <Dialog.Root open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <Dialog size="base" className="p-6">
          <Dialog.Title>Disconnect this Mac?</Dialog.Title>
          <Dialog.Description className="mt-2 text-pretty text-sm text-kumo-subtle">
            Ruth will immediately stop sending work to {device?.name ?? "this Mac"}.
            The helper stays installed and can be paired again later.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" size="sm" {...props}>
                  Cancel
                </Button>
              )}
            />
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              {busy ? <Loader size={14} /> : <TrashIcon />}
              Disconnect
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </section>
  );
}
