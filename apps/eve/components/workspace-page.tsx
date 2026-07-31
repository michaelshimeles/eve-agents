"use client";

import {
  Badge,
  Button,
  Dialog,
  Input,
  InputArea,
  Loader,
  Tabs,
} from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CaretRightIcon,
  CopyIcon,
  DownloadSimpleIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  HardDrivesIcon,
  LinkSimpleIcon,
  PlayIcon,
  PlusIcon,
  SidebarSimpleIcon,
  StopIcon,
  TerminalWindowIcon,
  TrashIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  WorkspaceConfigPatch,
  WorkspaceDirectory,
  WorkspaceEntry,
  WorkspaceForkAction,
  WorkspaceFsAction,
  WorkspaceLifecycleAction,
  WorkspaceOverview,
  WorkspaceProcess,
  WorkspaceSnapshotAction,
  WorkspaceTarget,
  WorkspaceTextFile,
} from "@/lib/workspace-api";
import {
  MAX_WORKSPACE_EDITOR_BYTES,
  MAX_WORKSPACE_TRANSFER_BYTES,
  WORKSPACE_ADMIN_HEADER,
  WORKSPACE_ROOT,
  WorkspaceApiError,
  workspaceJson,
} from "@/lib/workspace-api";
import { formatBytes } from "@/lib/voice/attachments";
import { cn } from "@/lib/utils";

const WorkspaceEditor = dynamic(
  () => import("@/components/workspace-editor").then((module) => module.WorkspaceEditor),
  { ssr: false, loading: () => <PanelLoader /> },
);
const WorkspaceTerminal = dynamic(
  () =>
    import("@/components/workspace-terminal").then((module) => module.WorkspaceTerminal),
  { ssr: false, loading: () => <PanelLoader /> },
);

type WorkspaceTab = "files" | "terminals" | "processes" | "ports" | "sandbox";

interface WorkspaceThread {
  id: string;
  title: string;
}

interface ConfirmAction {
  title: string;
  description: string;
  actionLabel: string;
  requiredName?: string;
  extra?: React.ReactNode;
  run: () => Promise<void>;
}

interface TerminalTab {
  id: string;
  title: string;
}

const ACTIVE_STATUSES = new Set(["pending", "running", "snapshotting"]);
const PREVIEW_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "pdf"]);

function PanelLoader() {
  return (
    <div className="flex h-full min-h-40 items-center justify-center text-kumo-subtle">
      <Loader size={20} />
    </div>
  );
}

function targetQuery(target: WorkspaceTarget): string {
  const search = new URLSearchParams({ sessionId: target.sessionId });
  if (target.targetName) search.set("targetName", target.targetName);
  return search.toString();
}

function targetBody(target: WorkspaceTarget): WorkspaceTarget {
  return {
    sessionId: target.sessionId,
    ...(target.targetName ? { targetName: target.targetName } : {}),
  };
}

function joinedPath(parent: string, name: string): string {
  return `${parent === WORKSPACE_ROOT ? WORKSPACE_ROOT : parent.replace(/\/$/, "")}/${name}`;
}

function parentPath(path: string): string {
  if (path === WORKSPACE_ROOT) return WORKSPACE_ROOT;
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}` || WORKSPACE_ROOT;
}

function fileExtension(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function dateTime(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function durationLabel(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)}s`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)}m`;
  return `${(milliseconds / 3_600_000).toFixed(1)}h`;
}

function statusBadge(status: string) {
  if (status === "running") {
    return (
      <Badge variant="success" appearance="dot">
        Running
      </Badge>
    );
  }
  if (status === "failed" || status === "aborted") {
    return (
      <Badge variant="error" appearance="dot">
        {status}
      </Badge>
    );
  }
  if (status === "pending" || status === "snapshotting" || status === "stopping") {
    return (
      <Badge variant="warning" appearance="dot">
        {status}
      </Badge>
    );
  }
  return (
    <Badge variant="neutral" appearance="dot">
      {status}
    </Badge>
  );
}

function socketUrl(
  path: "/transfer",
  target: WorkspaceTarget,
  developmentRelay: string | null,
  values: Record<string, string>,
): string {
  const url =
    developmentRelay === null
      ? new URL(`/api/workspace${path}`, window.location.href)
      : new URL(developmentRelay, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname =
    developmentRelay === null
      ? `/api/workspace${path}`
      : `${url.pathname.replace(/\/$/, "")}${path}`;
  url.searchParams.set("sessionId", target.sessionId);
  if (target.targetName) url.searchParams.set("targetName", target.targetName);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.toString();
}

async function waitForSocketBuffer(socket: WebSocket): Promise<void> {
  while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 4 * 1024 * 1024) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function WorkspacePage({
  sessionId,
  threadId,
  threads,
  onSelectThread,
  onOpenSidebar,
  onBack,
}: {
  sessionId?: string;
  threadId: string;
  threads: WorkspaceThread[];
  onSelectThread: (threadId: string) => void;
  onOpenSidebar: () => void;
  onBack: () => void;
}) {
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [targetName, setTargetName] = useState<string | undefined>();
  const [tab, setTab] = useState<WorkspaceTab>("files");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaceAuth, setWorkspaceAuth] = useState<{
    configured: boolean;
  } | null>(null);
  const [authToken, setAuthToken] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [confirmationName, setConfirmationName] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);

  const target = useMemo<WorkspaceTarget | null>(
    () =>
      sessionId
        ? {
            sessionId,
            ...(targetName ? { targetName } : {}),
          }
        : null,
    [sessionId, targetName],
  );

  const handleFailure = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof WorkspaceApiError && cause.authRequired) {
      setWorkspaceAuth({ configured: cause.authConfigured });
      setOverview(null);
      setError(null);
      return;
    }
    setError(cause instanceof Error ? cause.message : fallback);
  }, []);

  const refresh = useCallback(async () => {
    if (sessionId === undefined) {
      setOverview(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const search = new URLSearchParams({ sessionId });
      if (targetName) search.set("targetName", targetName);
      setOverview(await workspaceJson<WorkspaceOverview>(`/api/workspace?${search}`));
      setWorkspaceAuth(null);
    } catch (cause) {
      handleFailure(cause, "Could not load the workspace.");
    } finally {
      setLoading(false);
    }
  }, [handleFailure, sessionId, targetName]);

  useEffect(() => {
    setTargetName(undefined);
    setOverview(null);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (confirm === null) setConfirmationName("");
  }, [confirm]);

  const run = useCallback(
    async (work: () => Promise<unknown>, success: string) => {
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        await work();
        setNotice(success);
        await refresh();
      } catch (cause) {
        handleFailure(cause, "Workspace action failed.");
        throw cause;
      } finally {
        setLoading(false);
      }
    },
    [handleFailure, refresh],
  );

  async function unlockWorkspace(): Promise<void> {
    const token = authToken.trim();
    if (token.length === 0) return;
    setAuthBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/workspace/auth", {
        method: "POST",
        headers: { [WORKSPACE_ADMIN_HEADER]: token },
      });
      const body = (await response.json().catch(() => null)) as
        | {
            error?: string;
            authRequired?: boolean;
            authConfigured?: boolean;
          }
        | null;
      if (!response.ok) {
        setWorkspaceAuth({
          configured: body?.authConfigured === true,
        });
        throw new Error(body?.error ?? "Workspace unlock failed.");
      }
      setAuthToken("");
      setWorkspaceAuth(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Workspace unlock failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function workspaceAction(
    scope: "lifecycle" | "snapshot" | "fork",
    action: WorkspaceLifecycleAction | WorkspaceSnapshotAction | WorkspaceForkAction,
    success: string,
  ): Promise<void> {
    if (target === null) return;
    await run(
      () =>
        workspaceJson("/api/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...targetBody(target), scope, action }),
        }),
      success,
    );
  }

  const targetRunning =
    overview?.target !== null && overview?.target !== undefined
      ? ACTIVE_STATUSES.has(overview.target.status)
      : false;
  const selectedThread = threads.find((thread) => thread.id === threadId);
  const relatedTargets = overview
    ? [
        ...(overview.root ? [overview.root] : []),
        ...overview.generations,
        ...overview.related,
      ].filter(
        (item, index, list) => list.findIndex((candidate) => candidate.name === item.name) === index,
      )
    : [];

  return (
    <main className="flex h-dvh min-w-0 flex-1 flex-col bg-kumo-canvas">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-kumo-hairline px-3 py-2 sm:px-4">
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={SidebarSimpleIcon}
          aria-label="Open sidebar"
          className="md:hidden"
          onClick={onOpenSidebar}
        />
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={ArrowLeftIcon}
          aria-label="Back to chat"
          onClick={onBack}
        />
        <div className="min-w-40 flex-1">
          <h1 className="text-balance text-sm font-semibold text-kumo-strong">Workspace</h1>
          <p className="truncate text-xs text-kumo-subtle">
            Files, terminals, processes, ports, and sandbox controls
          </p>
        </div>
        <label className="sr-only" htmlFor="workspace-conversation">
          Conversation
        </label>
        <select
          id="workspace-conversation"
          value={threadId}
          className="h-7 max-w-56 rounded-md bg-kumo-base px-2 text-xs text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus"
          onChange={(event) => onSelectThread(event.target.value)}
        >
          {threads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.title}
            </option>
          ))}
        </select>
        {overview?.target && statusBadge(overview.target.status)}
        {overview?.target && (
          <Button
            size="sm"
            variant={targetRunning ? "secondary" : "primary"}
            icon={targetRunning ? StopIcon : PlayIcon}
            loading={loading}
            onClick={() => {
              if (targetRunning) {
                void workspaceAction("lifecycle", { type: "stop" }, "Workspace stopped.");
              } else {
                void workspaceAction("lifecycle", { type: "resume" }, "Workspace resumed.");
              }
            }}
          >
            {targetRunning ? "Stop" : "Resume"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={ArrowClockwiseIcon}
          aria-label="Refresh workspace"
          loading={loading}
          onClick={() => void refresh()}
        />
      </header>

      <div className="border-b border-kumo-hairline bg-kumo-warning-tint/40 px-4 py-2 text-xs text-kumo-warning">
        {overview?.warning ??
          "Workspace access is powerful and restricted to this deployment's authenticated owner."}
      </div>

      {error !== null && (
        <div className="flex items-start justify-between gap-4 border-b border-kumo-danger/20 bg-kumo-danger-tint px-4 py-2.5 text-sm text-kumo-danger">
          <p className="text-pretty">{error}</p>
          <Button variant="ghost" size="xs" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      {notice !== null && (
        <div className="flex items-start justify-between gap-4 border-b border-kumo-success/20 bg-kumo-success-tint px-4 py-2.5 text-sm text-kumo-success">
          <p className="text-pretty">{notice}</p>
          <Button variant="ghost" size="xs" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {sessionId === undefined ? (
        <EmptyWorkspace
          title="This conversation has no Eve session yet"
          description={`Send a message in “${selectedThread?.title ?? "this conversation"}” first. Its workspace will be attached to the session Eve creates.`}
          onBack={onBack}
        />
      ) : workspaceAuth !== null ? (
        <WorkspaceAuthGate
          configured={workspaceAuth.configured}
          token={authToken}
          busy={authBusy}
          onToken={setAuthToken}
          onUnlock={() => void unlockWorkspace()}
          onBack={onBack}
        />
      ) : overview === null ? (
        <PanelLoader />
      ) : overview.state === "not_started" ? (
        <EmptyWorkspace
          title="This workspace has not been used yet"
          description="Ask Ruth to create or inspect a file, run a command, or use the browser. The sandbox will appear here as soon as Eve provisions it."
          onBack={onBack}
        />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-kumo-hairline px-4 py-2">
            <Tabs
              variant="underline"
              size="sm"
              value={tab}
              tabs={[
                { value: "files", label: "Files" },
                { value: "terminals", label: "Terminals" },
                { value: "processes", label: "Processes" },
                { value: "ports", label: "Ports" },
                { value: "sandbox", label: "Sandbox" },
              ]}
              onValueChange={(value) => setTab(value as WorkspaceTab)}
            />
            <label className="ms-auto flex items-center gap-2 text-xs text-kumo-subtle">
              Sandbox
              <select
                value={overview.target?.name ?? ""}
                className="h-7 max-w-72 rounded-md bg-kumo-base px-2 font-mono text-xs text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus"
                onChange={(event) => {
                  const name = event.target.value;
                  setTargetName(name === overview.root?.name ? undefined : name);
                }}
              >
                {relatedTargets.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.kind}: {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="min-h-0 flex-1">
            {!targetRunning && tab !== "sandbox" ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <span className="mb-4 flex size-11 items-center justify-center rounded-xl bg-kumo-tint text-kumo-default">
                  <StopIcon className="size-5" aria-hidden />
                </span>
                <h2 className="text-balance text-base font-semibold text-kumo-strong">
                  This sandbox is stopped
                </h2>
                <p className="mt-1 max-w-md text-pretty text-sm text-kumo-subtle">
                  Resume it to browse files, open terminals, inspect processes, or preview a
                  port.
                </p>
                <Button
                  className="mt-4"
                  variant="primary"
                  icon={PlayIcon}
                  loading={loading}
                  onClick={() =>
                    void workspaceAction("lifecycle", { type: "resume" }, "Workspace resumed.")
                  }
                >
                  Resume workspace
                </Button>
              </div>
            ) : tab === "files" && target !== null ? (
              <FilesPanel
                target={target}
                developmentRelay={overview.devTerminalUrl}
                confirm={setConfirm}
                onError={setError}
              />
            ) : tab === "terminals" && target !== null ? (
              <TerminalsPanel
                key={`${target.sessionId}:${target.targetName ?? "root"}`}
                target={target}
                developmentRelay={overview.devTerminalUrl}
              />
            ) : tab === "processes" && target !== null ? (
              <ProcessesPanel
                target={target}
                confirm={setConfirm}
                onError={setError}
              />
            ) : tab === "ports" && target !== null && overview.target ? (
              <PortsPanel
                target={target}
                routes={overview.target.routes}
                onSaved={refresh}
                onError={setError}
              />
            ) : tab === "sandbox" && target !== null && overview.target ? (
              <SandboxPanel
                overview={overview}
                loading={loading}
                confirm={setConfirm}
                action={workspaceAction}
                patch={async (configuration, success) => {
                  await run(
                    () =>
                      workspaceJson("/api/workspace", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          ...targetBody(target),
                          patch: configuration,
                        }),
                      }),
                    success,
                  );
                }}
              />
            ) : null}
          </div>
        </>
      )}

      <Dialog.Root
        role="alertdialog"
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !loading && !confirmBusy) setConfirm(null);
        }}
      >
        <Dialog size="base" className="p-6">
          <Dialog.Title>{confirm?.title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-pretty text-sm text-kumo-subtle">
            {confirm?.description}
          </Dialog.Description>
          {confirm?.extra}
          {confirm?.requiredName && (
            <div className="mt-4">
              <label
                className="mb-1.5 block text-xs font-medium text-kumo-default"
                htmlFor="workspace-confirm-name"
              >
                Type <span className="font-mono">{confirm.requiredName}</span> to continue
              </label>
              <Input
                id="workspace-confirm-name"
                value={confirmationName}
                autoComplete="off"
                className="w-full font-mono"
                onChange={(event) => setConfirmationName(event.target.value)}
              />
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="secondary" disabled={loading}>
                  Cancel
                </Button>
              )}
            />
            <Button
              variant="destructive"
              loading={loading || confirmBusy}
              disabled={
                confirm?.requiredName !== undefined &&
                confirmationName !== confirm.requiredName
              }
              onClick={() => {
                const current = confirm;
                if (current === null) return;
                setConfirmBusy(true);
                void current
                  .run()
                  .then(() => setConfirm(null))
                  .catch(() => undefined)
                  .finally(() => setConfirmBusy(false));
              }}
            >
              {confirm?.actionLabel ?? "Confirm"}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </main>
  );
}

function WorkspaceAuthGate({
  configured,
  token,
  busy,
  onToken,
  onUnlock,
  onBack,
}: {
  configured: boolean;
  token: string;
  busy: boolean;
  onToken: (value: string) => void;
  onUnlock: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-[8vh] text-center">
      <span className="mb-4 flex size-11 items-center justify-center rounded-xl bg-kumo-tint text-kumo-default">
        <HardDrivesIcon className="size-5" aria-hidden />
      </span>
      <h2 className="text-balance text-base font-semibold text-kumo-strong">
        Workspace access is locked
      </h2>
      {configured ? (
        <form
          className="mt-3 flex w-full max-w-sm flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onUnlock();
          }}
        >
          <p className="text-pretty text-sm text-kumo-subtle">
            Enter this deployment&rsquo;s workspace admin token. It is exchanged
            for a short-lived, HttpOnly owner session and is not saved in browser
            storage.
          </p>
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              type="password"
              value={token}
              placeholder="Admin token"
              aria-label="Workspace admin token"
              autoComplete="current-password"
              className="flex-1"
              onChange={(event) => onToken(event.target.value)}
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={busy}
              disabled={token.trim().length === 0}
            >
              Unlock
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-1 max-w-md text-pretty text-sm text-kumo-subtle">
          Set <code className="font-mono">WORKSPACE_ADMIN_TOKEN</code> on this
          deployment and reload. Public deployments fail closed because this
          surface provides shell and filesystem control.
        </p>
      )}
      <Button className="mt-4" size="sm" variant="secondary" onClick={onBack}>
        Go to chat
      </Button>
    </div>
  );
}

function EmptyWorkspace({
  title,
  description,
  onBack,
}: {
  title: string;
  description: string;
  onBack: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-[8vh] text-center">
      <span className="mb-4 flex size-11 items-center justify-center rounded-xl bg-kumo-tint text-kumo-default">
        <HardDrivesIcon className="size-5" aria-hidden />
      </span>
      <h2 className="text-balance text-base font-semibold text-kumo-strong">{title}</h2>
      <p className="mt-1 max-w-md text-pretty text-sm text-kumo-subtle">{description}</p>
      <Button className="mt-4" size="sm" onClick={onBack}>
        Go to chat
      </Button>
    </div>
  );
}

function FilesPanel({
  target,
  developmentRelay,
  confirm,
  onError,
}: {
  target: WorkspaceTarget;
  developmentRelay: string | null;
  confirm: (action: ConfirmAction | null) => void;
  onError: (message: string | null) => void;
}) {
  const [directoryPath, setDirectoryPath] = useState(WORKSPACE_ROOT);
  const [directory, setDirectory] = useState<WorkspaceDirectory | null>(null);
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null);
  const [file, setFile] = useState<WorkspaceTextFile | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const query = targetQuery(target);

  const loadDirectory = useCallback(
    async (path = directoryPath) => {
      setBusy(true);
      onError(null);
      try {
        const result = await workspaceJson<WorkspaceDirectory>(
          `/api/workspace/fs?${query}&path=${encodeURIComponent(path)}`,
        );
        setDirectory(result);
        setDirectoryPath(result.path);
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : "Could not load the directory.");
      } finally {
        setBusy(false);
      }
    },
    [directoryPath, onError, query],
  );

  useEffect(() => {
    setDirectoryPath(WORKSPACE_ROOT);
    setSelected(null);
    setFile(null);
    setDraft("");
    setDirty(false);
  }, [target.sessionId, target.targetName]);

  useEffect(() => {
    void loadDirectory(WORKSPACE_ROOT);
    // loadDirectory intentionally tracks the current directory for refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.sessionId, target.targetName]);

  async function selectEntry(entry: WorkspaceEntry): Promise<void> {
    if (entry.kind === "directory") {
      setSelected(null);
      setFile(null);
      setDirty(false);
      await loadDirectory(entry.path);
      return;
    }
    setSelected(entry);
    setFile(null);
    setDraft("");
    setDirty(false);
    if (entry.kind !== "file" || entry.size > MAX_WORKSPACE_EDITOR_BYTES) return;
    setBusy(true);
    try {
      const result = await workspaceJson<WorkspaceTextFile>(
        `/api/workspace/fs/content?${query}&path=${encodeURIComponent(entry.path)}&mode=text`,
      );
      setFile(result);
      setDraft(result.content);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not open the file.";
      if (!message.toLowerCase().includes("binary")) onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function mutate(action: WorkspaceFsAction, success?: () => void): Promise<void> {
    setBusy(true);
    onError(null);
    try {
      await workspaceJson("/api/workspace/fs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...targetBody(target), action }),
      });
      success?.();
      await loadDirectory();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Filesystem action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveFile(): Promise<void> {
    if (file === null || !dirty) return;
    setBusy(true);
    onError(null);
    try {
      const saved = await workspaceJson<WorkspaceTextFile>("/api/workspace/fs/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...targetBody(target),
          path: file.path,
          content: draft,
          expectedVersion: file.version,
        }),
      });
      setFile(saved);
      setSelected((current) =>
        current ? { ...current, version: saved.version, size: saved.size } : current,
      );
      setDirty(false);
      await loadDirectory();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not save the file.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntry(entry: WorkspaceEntry): Promise<void> {
    setBusy(true);
    onError(null);
    try {
      await workspaceJson("/api/workspace/fs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...targetBody(target),
          action: {
            type: "delete",
            path: entry.path,
            recursive: entry.kind === "directory",
          } satisfies WorkspaceFsAction,
        }),
      });
      setSelected(null);
      setFile(null);
      setDirty(false);
      await loadDirectory();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not delete the entry.");
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(upload: File): Promise<void> {
    if (upload.size > MAX_WORKSPACE_TRANSFER_BYTES) {
      onError("Workspace uploads are limited to 256 MiB.");
      return;
    }
    const destination = joinedPath(directoryPath, upload.name);
    setBusy(true);
    setUploadProgress(0);
    onError(null);
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(
          socketUrl("/transfer", target, developmentRelay, {
            path: destination,
            size: String(upload.size),
            overwrite: "0",
          }),
        );
        let started = false;
        socket.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(String(event.data)) as {
              type?: string;
              received?: number;
            };
            if (message.type === "ready" && !started) {
              started = true;
              void (async () => {
                for (let offset = 0; offset < upload.size; offset += 256 * 1024) {
                  const chunk = await upload.slice(offset, offset + 256 * 1024).arrayBuffer();
                  socket.send(chunk);
                  await waitForSocketBuffer(socket);
                }
                socket.send(JSON.stringify({ type: "commit" }));
              })().catch(reject);
            } else if (message.type === "progress" && typeof message.received === "number") {
              setUploadProgress(
                upload.size === 0 ? 100 : Math.round((message.received / upload.size) * 100),
              );
            } else if (message.type === "complete") {
              setUploadProgress(100);
              resolve();
            }
          } catch {
            reject(new Error("The upload relay returned an invalid response."));
          }
        });
        socket.addEventListener("error", () =>
          reject(new Error("Could not connect to the upload relay.")),
        );
        socket.addEventListener("close", (event) => {
          if (event.code !== 1000) reject(new Error(event.reason || "The upload failed."));
        });
      });
      await loadDirectory();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  }

  const contentHref = selected
    ? `/api/workspace/fs/content?${query}&path=${encodeURIComponent(selected.path)}`
    : "";
  const crumbs = directoryPath.split("/").filter(Boolean);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col border-e border-kumo-hairline bg-kumo-base">
        <div className="flex min-h-11 flex-wrap items-center gap-1 border-b border-kumo-hairline px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            icon={ArrowLeftIcon}
            disabled={directoryPath === WORKSPACE_ROOT || busy}
            onClick={() => {
              setSelected(null);
              setFile(null);
              void loadDirectory(parentPath(directoryPath));
            }}
          >
            Up
          </Button>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={ArrowClockwiseIcon}
            aria-label="Refresh directory"
            loading={busy}
            onClick={() => void loadDirectory()}
          />
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={FilePlusIcon}
            aria-label="New file"
            onClick={() => {
              const name = window.prompt("New file name");
              if (name?.trim()) {
                void mutate({ type: "create-file", path: joinedPath(directoryPath, name.trim()) });
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={FolderPlusIcon}
            aria-label="New folder"
            onClick={() => {
              const name = window.prompt("New folder name");
              if (name?.trim()) {
                void mutate({
                  type: "create-directory",
                  path: joinedPath(directoryPath, name.trim()),
                });
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={UploadSimpleIcon}
            aria-label="Upload file"
            onClick={() => uploadRef.current?.click()}
          />
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={LinkSimpleIcon}
            aria-label="New symbolic link"
            onClick={() => {
              const name = window.prompt("New symbolic link name");
              if (!name?.trim()) return;
              const linkTarget = window.prompt("Link target inside /workspace");
              if (linkTarget?.trim()) {
                void mutate({
                  type: "symlink",
                  path: joinedPath(directoryPath, name.trim()),
                  target: linkTarget.trim(),
                });
              }
            }}
          />
          <input
            ref={uploadRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const upload = event.target.files?.[0];
              event.target.value = "";
              if (upload) void uploadFile(upload);
            }}
          />
          {uploadProgress !== null && (
            <span className="ms-auto text-xs tabular-nums text-kumo-subtle">
              Upload {uploadProgress}%
            </span>
          )}
        </div>
        <nav
          aria-label="Workspace path"
          className="flex min-h-9 items-center gap-1 overflow-x-auto border-b border-kumo-hairline px-3 text-xs"
        >
          {crumbs.map((crumb, index) => {
            const path = `/${crumbs.slice(0, index + 1).join("/")}`;
            return (
              <span key={path} className="flex items-center gap-1">
                {index > 0 && <CaretRightIcon className="size-3 text-kumo-subtle" />}
                <button
                  type="button"
                  className="rounded-sm px-1 py-0.5 font-medium text-kumo-default hover:bg-kumo-tint"
                  onClick={() => void loadDirectory(path)}
                >
                  {crumb}
                </button>
              </span>
            );
          })}
        </nav>
        <div className="min-h-0 flex-1 overflow-auto">
          {directory === null ? (
            <PanelLoader />
          ) : directory.entries.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-kumo-subtle">Empty folder</p>
          ) : (
            <ul className="divide-y divide-kumo-hairline">
              {directory.entries.map((entry) => {
                const Icon = entry.kind === "directory" ? FolderIcon : FileIcon;
                return (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className={cn(
                        "grid w-full grid-cols-[1fr_auto] gap-3 px-3 py-2 text-start outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus",
                        selected?.path === entry.path && "bg-kumo-tint",
                      )}
                      onClick={() => void selectEntry(entry)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Icon className="size-4 shrink-0 text-kumo-subtle" aria-hidden />
                        <span className="truncate text-sm text-kumo-default">{entry.name}</span>
                        {entry.kind === "symlink" && (
                          <Badge variant={entry.externalSymlink ? "warning" : "secondary"}>
                            link
                          </Badge>
                        )}
                      </span>
                      <span className="text-xs tabular-nums text-kumo-subtle">
                        {entry.kind === "directory" ? "" : formatBytes(entry.size)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="flex min-h-0 flex-col bg-kumo-base">
        {selected === null ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <FileIcon className="mb-3 size-7 text-kumo-subtle" aria-hidden />
            <h2 className="text-balance text-sm font-semibold text-kumo-strong">
              Select a file
            </h2>
            <p className="mt-1 text-pretty text-xs text-kumo-subtle">
              Text files open in the editor. Images and PDFs open in a safe preview.
            </p>
          </div>
        ) : (
          <>
            <div className="flex min-h-11 flex-wrap items-center gap-1 border-b border-kumo-hairline px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-kumo-strong">{selected.name}</p>
                <p className="truncate font-mono text-[11px] text-kumo-subtle">
                  {selected.path} · {formatBytes(selected.size)} · {selected.mode.toString(8)}
                </p>
              </div>
              {file && (
                <Button
                  size="sm"
                  variant={dirty ? "primary" : "secondary"}
                  disabled={!dirty}
                  loading={busy}
                  onClick={() => void saveFile()}
                >
                  Save
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={CopyIcon}
                aria-label="Copy file or folder"
                onClick={() => {
                  const destination = window.prompt("Copy to path", `${selected.path}.copy`);
                  if (destination?.trim()) {
                    void mutate({ type: "copy", path: selected.path, destination });
                  }
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const destination = window.prompt("Rename to path", selected.path);
                  if (destination?.trim() && destination !== selected.path) {
                    void mutate(
                      { type: "rename", path: selected.path, destination },
                      () => {
                        setSelected(null);
                        setFile(null);
                      },
                    );
                  }
                }}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const mode = window.prompt(
                    "Unix permissions (octal)",
                    selected.mode.toString(8),
                  );
                  if (mode && /^[0-7]{3,4}$/.test(mode)) {
                    void mutate({ type: "chmod", path: selected.path, mode: parseInt(mode, 8) });
                  }
                }}
              >
                Permissions
              </Button>
              <a
                href={`${contentHref}&download=1`}
                download={selected.name}
                className="inline-flex h-6.5 items-center gap-1 rounded-md px-2 text-xs text-kumo-default hover:bg-kumo-tint"
              >
                <DownloadSimpleIcon className="size-3.5" />
                Download
              </a>
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={TrashIcon}
                aria-label="Delete entry"
                className="text-kumo-danger"
                onClick={() => {
                  const entry = selected;
                  confirm({
                    title: `Delete ${entry.name}?`,
                    description:
                      entry.kind === "directory"
                        ? "This folder and everything inside it will be permanently removed."
                        : "This file will be permanently removed.",
                    actionLabel: "Delete",
                    run: () => deleteEntry(entry),
                  });
                }}
              />
            </div>
            <div className="min-h-0 flex-1">
              {busy && file === null ? (
                <PanelLoader />
              ) : file ? (
                <WorkspaceEditor
                  path={file.path}
                  value={draft}
                  onChange={(value) => {
                    setDraft(value);
                    setDirty(value !== file.content);
                  }}
                  onSave={() => void saveFile()}
                />
              ) : PREVIEW_EXTENSIONS.has(fileExtension(selected.path)) ? (
                fileExtension(selected.path) === "pdf" ? (
                  <iframe
                    title={`Preview ${selected.name}`}
                    src={contentHref}
                    sandbox=""
                    className="h-full w-full border-0 bg-white"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={contentHref}
                    alt={selected.name}
                    className="h-full w-full object-contain p-4"
                  />
                )
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                  <FileIcon className="mb-3 size-7 text-kumo-subtle" aria-hidden />
                  <p className="text-sm font-medium text-kumo-strong">
                    Preview unavailable
                  </p>
                  <p className="mt-1 max-w-sm text-pretty text-xs text-kumo-subtle">
                    This file is binary or larger than {formatBytes(MAX_WORKSPACE_EDITOR_BYTES)}.
                    Download it to inspect it locally.
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function TerminalsPanel({
  target,
  developmentRelay,
}: {
  target: WorkspaceTarget;
  developmentRelay: string | null;
}) {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [
    { id: crypto.randomUUID(), title: "Terminal 1" },
  ]);
  const [activeId, setActiveId] = useState(tabs[0]?.id ?? "");

  function addTerminal(): void {
    const next = {
      id: crypto.randomUUID(),
      title: `Terminal ${tabs.length + 1}`,
    };
    setTabs((current) => [...current, next]);
    setActiveId(next.id);
  }

  function closeTerminal(id: string): void {
    setTabs((current) => {
      const remaining = current.filter((item) => item.id !== id);
      if (remaining.length === 0) {
        const replacement = { id: crypto.randomUUID(), title: "Terminal 1" };
        setActiveId(replacement.id);
        return [replacement];
      }
      if (activeId === id) setActiveId(remaining[0].id);
      return remaining;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#111318]">
      <div className="flex min-h-10 items-center gap-1 overflow-x-auto border-b border-white/10 bg-[#171a20] px-2">
        {tabs.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex h-7 shrink-0 items-center rounded-md text-xs text-white/70",
              activeId === item.id && "bg-white/10 text-white",
            )}
          >
            <button
              type="button"
              className="flex h-full items-center gap-1.5 px-2"
              onClick={() => setActiveId(item.id)}
              onDoubleClick={() => {
                const title = window.prompt("Terminal name", item.title);
                if (title?.trim()) {
                  setTabs((current) =>
                    current.map((candidate) =>
                      candidate.id === item.id
                        ? { ...candidate, title: title.trim() }
                        : candidate,
                    ),
                  );
                }
              }}
            >
              <TerminalWindowIcon className="size-3.5" />
              {item.title}
            </button>
            <button
              type="button"
              className="me-1 rounded-sm p-0.5 hover:bg-white/10"
              aria-label={`Close ${item.title}`}
              onClick={() => closeTerminal(item.id)}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
          aria-label="New terminal"
          onClick={addTerminal}
        >
          <PlusIcon className="size-3.5" />
        </button>
        <p className="ms-auto shrink-0 px-2 text-[11px] text-white/50">
          Double-click a tab to rename it
        </p>
      </div>
      <div className="min-h-0 flex-1">
        {tabs.map((item) => (
          <WorkspaceTerminal
            key={item.id}
            target={target}
            developmentRelay={developmentRelay}
            visible={activeId === item.id}
          />
        ))}
      </div>
    </div>
  );
}

function ProcessesPanel({
  target,
  confirm,
  onError,
}: {
  target: WorkspaceTarget;
  confirm: (action: ConfirmAction | null) => void;
  onError: (message: string | null) => void;
}) {
  const [processes, setProcesses] = useState<WorkspaceProcess[] | null>(null);
  const [busy, setBusy] = useState(false);
  const query = targetQuery(target);

  const loadProcesses = useCallback(async () => {
    try {
      const result = await workspaceJson<{ processes: WorkspaceProcess[] }>(
        `/api/workspace/processes?${query}`,
      );
      setProcesses(result.processes);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not load processes.");
    }
  }, [onError, query]);

  useEffect(() => {
    void loadProcesses();
    const timer = window.setInterval(() => void loadProcesses(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadProcesses]);

  async function signal(pid: number, signalName: "TERM" | "KILL"): Promise<void> {
    setBusy(true);
    onError(null);
    try {
      await workspaceJson("/api/workspace/processes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...targetBody(target), pid, signal: signalName }),
      });
      await loadProcesses();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not signal the process.");
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-balance text-base font-semibold text-kumo-strong">
            Processes
          </h2>
          <p className="text-pretty text-sm text-kumo-subtle">
            Live process list, refreshed every three seconds.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={ArrowClockwiseIcon}
          loading={busy}
          onClick={() => void loadProcesses()}
        >
          Refresh
        </Button>
      </div>
      {processes === null ? (
        <PanelLoader />
      ) : (
        <div className="overflow-x-auto rounded-xl bg-kumo-base ring ring-kumo-hairline">
          <table className="w-full min-w-3xl text-start text-xs">
            <thead className="border-b border-kumo-hairline bg-kumo-tint text-kumo-subtle">
              <tr>
                <th className="px-3 py-2 text-start font-medium">PID</th>
                <th className="px-3 py-2 text-start font-medium">User</th>
                <th className="px-3 py-2 text-start font-medium">State</th>
                <th className="px-3 py-2 text-end font-medium">CPU</th>
                <th className="px-3 py-2 text-end font-medium">Memory</th>
                <th className="px-3 py-2 text-start font-medium">Command</th>
                <th className="px-3 py-2 text-end font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-kumo-hairline">
              {processes.map((process) => (
                <tr key={process.pid}>
                  <td className="px-3 py-2 font-mono tabular-nums">{process.pid}</td>
                  <td className="px-3 py-2">{process.user}</td>
                  <td className="px-3 py-2">{process.state}</td>
                  <td className="px-3 py-2 text-end tabular-nums">
                    {process.cpuPercent.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums">
                    {process.memoryPercent.toFixed(1)}%
                  </td>
                  <td className="max-w-xl truncate px-3 py-2 font-mono">
                    {process.command}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy || process.pid <= 1}
                        onClick={() => void signal(process.pid, "TERM")}
                      >
                        TERM
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary-destructive"
                        disabled={busy || process.pid <= 1}
                        onClick={() =>
                          confirm({
                            title: `Kill process ${process.pid}?`,
                            description:
                              "SIGKILL stops the process immediately without allowing cleanup.",
                            actionLabel: "Kill process",
                            run: () => signal(process.pid, "KILL"),
                          })
                        }
                      >
                        KILL
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PortsPanel({
  target,
  routes,
  onSaved,
  onError,
}: {
  target: WorkspaceTarget;
  routes: Array<{ port: number; url: string }>;
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [ports, setPorts] = useState(routes.map((route) => route.port).join(", "));
  const [selectedPort, setSelectedPort] = useState<number | null>(routes[0]?.port ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPorts(routes.map((route) => route.port).join(", "));
    setSelectedPort((current) =>
      current !== null && routes.some((route) => route.port === current)
        ? current
        : (routes[0]?.port ?? null),
    );
  }, [routes]);

  const selectedRoute = routes.find((route) => route.port === selectedPort);

  async function savePorts(): Promise<void> {
    const values = ports
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map(Number);
    setBusy(true);
    onError(null);
    try {
      await workspaceJson("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...targetBody(target), patch: { ports: values } }),
      });
      await onSaved();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not update ports.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <section className="overflow-auto border-e border-kumo-hairline bg-kumo-base p-4">
        <h2 className="text-balance text-base font-semibold text-kumo-strong">
          Published ports
        </h2>
        <p className="mt-1 text-pretty text-sm text-kumo-subtle">
          Publish up to 15 ports. Their public URLs remain available while the sandbox is
          running.
        </p>
        <label className="mt-5 block text-xs font-medium text-kumo-default" htmlFor="ports">
          Ports, separated by commas
        </label>
        <Input
          id="ports"
          value={ports}
          className="mt-1.5 w-full font-mono"
          placeholder="3000, 5173"
          onChange={(event) => setPorts(event.target.value)}
        />
        <Button
          className="mt-3"
          size="sm"
          variant="primary"
          loading={busy}
          onClick={() => void savePorts()}
        >
          Save ports
        </Button>
        <div className="mt-6 space-y-2">
          {routes.length === 0 ? (
            <p className="rounded-lg bg-kumo-tint px-3 py-4 text-sm text-kumo-subtle">
              No ports are published.
            </p>
          ) : (
            routes.map((route) => (
              <button
                key={route.port}
                type="button"
                className={cn(
                  "w-full rounded-lg px-3 py-2 text-start ring ring-kumo-hairline hover:bg-kumo-tint",
                  selectedPort === route.port && "bg-kumo-tint ring-kumo-focus/30",
                )}
                onClick={() => setSelectedPort(route.port)}
              >
                <span className="block text-sm font-medium text-kumo-strong">
                  Port {route.port}
                </span>
                <span className="block truncate text-xs text-kumo-subtle">{route.url}</span>
              </button>
            ))
          )}
        </div>
      </section>
      <section className="flex min-h-0 flex-col bg-kumo-base">
        <div className="flex min-h-11 items-center gap-2 border-b border-kumo-hairline px-3">
          <p className="min-w-0 flex-1 truncate text-xs text-kumo-subtle">
            {selectedRoute?.url ?? "Select a published port to preview it"}
          </p>
          {selectedRoute && (
            <a
              href={selectedRoute.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-kumo-default hover:bg-kumo-tint"
            >
              <ArrowSquareOutIcon className="size-3.5" />
              Open
            </a>
          )}
        </div>
        {selectedRoute ? (
          <iframe
            key={selectedRoute.url}
            title={`Preview port ${selectedRoute.port}`}
            src={selectedRoute.url}
            sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin"
            className="min-h-0 flex-1 border-0 bg-white"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-kumo-subtle">
            No preview selected
          </div>
        )}
      </section>
    </div>
  );
}

function SandboxPanel({
  overview,
  loading,
  confirm,
  action,
  patch,
}: {
  overview: WorkspaceOverview;
  loading: boolean;
  confirm: (action: ConfirmAction | null) => void;
  action: (
    scope: "lifecycle" | "snapshot" | "fork",
    action: WorkspaceLifecycleAction | WorkspaceSnapshotAction | WorkspaceForkAction,
    success: string,
  ) => Promise<void>;
  patch: (configuration: WorkspaceConfigPatch, success: string) => Promise<void>;
}) {
  const sandbox = overview.target;
  const [vcpus, setVcpus] = useState(String(sandbox?.vcpus ?? 2));
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    String(Math.round((sandbox?.timeoutMs ?? 300_000) / 60_000)),
  );
  const [persistent, setPersistent] = useState(sandbox?.persistent ?? true);
  const [snapshotExpirationMinutes, setSnapshotExpirationMinutes] = useState(
    String(Math.round((sandbox?.snapshotExpirationMs ?? 0) / 60_000)),
  );
  const [keepSnapshots, setKeepSnapshots] = useState(
    sandbox?.keepLastSnapshots !== null,
  );
  const [keepSnapshotCount, setKeepSnapshotCount] = useState(
    String(sandbox?.keepLastSnapshots?.count ?? 5),
  );
  const [deleteEvictedSnapshots, setDeleteEvictedSnapshots] = useState(
    sandbox?.keepLastSnapshots?.deleteEvicted ?? true,
  );
  const [networkMode, setNetworkMode] = useState<"allow-all" | "deny-all" | "custom">(
    sandbox?.networkPolicy.mode ?? "allow-all",
  );
  const [allowedDomains, setAllowedDomains] = useState(
    sandbox?.networkPolicy.mode === "custom"
      ? sandbox.networkPolicy.allowedDomains.join("\n")
      : "",
  );
  const [allowedCidrs, setAllowedCidrs] = useState(
    sandbox?.networkPolicy.mode === "custom" ? sandbox.networkPolicy.allowedCidrs.join("\n") : "",
  );
  const [deniedCidrs, setDeniedCidrs] = useState(
    sandbox?.networkPolicy.mode === "custom" ? sandbox.networkPolicy.deniedCidrs.join("\n") : "",
  );

  useEffect(() => {
    if (!sandbox) return;
    setVcpus(String(sandbox.vcpus ?? 2));
    setTimeoutMinutes(String(Math.round((sandbox.timeoutMs ?? 300_000) / 60_000)));
    setPersistent(sandbox.persistent);
    setSnapshotExpirationMinutes(
      String(Math.round((sandbox.snapshotExpirationMs ?? 0) / 60_000)),
    );
    setKeepSnapshots(sandbox.keepLastSnapshots !== null);
    setKeepSnapshotCount(String(sandbox.keepLastSnapshots?.count ?? 5));
    setDeleteEvictedSnapshots(sandbox.keepLastSnapshots?.deleteEvicted ?? true);
    setNetworkMode(sandbox.networkPolicy.mode);
    if (sandbox.networkPolicy.mode === "custom") {
      setAllowedDomains(sandbox.networkPolicy.allowedDomains.join("\n"));
      setAllowedCidrs(sandbox.networkPolicy.allowedCidrs.join("\n"));
      setDeniedCidrs(sandbox.networkPolicy.deniedCidrs.join("\n"));
    }
  }, [sandbox]);

  if (!sandbox) return null;

  function values(text: string): string[] {
    return text
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-balance text-base font-semibold text-kumo-strong">
                Sandbox
              </h2>
              <p className="mt-1 break-all font-mono text-xs text-kumo-subtle">
                {sandbox.name}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                icon={GitBranchIcon}
                loading={loading}
                onClick={() => {
                  const label = window.prompt("Fork label (optional)") ?? undefined;
                  if (label !== undefined) {
                    void action("fork", { type: "create", label }, "Fork created.");
                  }
                }}
              >
                Create fork
              </Button>
              <Button
                size="sm"
                loading={loading}
                onClick={() =>
                  void action("snapshot", { type: "create" }, "Snapshot created.")
                }
              >
                Create snapshot
              </Button>
              {sandbox.kind === "root" ? (
                <Button
                  size="sm"
                  variant="secondary-destructive"
                  onClick={() =>
                    confirm({
                      title: "Reset this workspace?",
                      description:
                        "The active Eve sandbox will be deleted. A recovery backup will be created first, and Eve will provision a fresh workspace the next time it needs one.",
                      actionLabel: "Reset workspace",
                      requiredName: sandbox.name,
                      run: () =>
                        action(
                          "lifecycle",
                          { type: "reset", confirmation: sandbox.name, keepBackup: true },
                          "Workspace reset. A recovery backup was preserved.",
                        ),
                    })
                  }
                >
                  Reset
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary-destructive"
                  onClick={() =>
                    confirm({
                      title: `Delete this ${sandbox.kind}?`,
                      description:
                        "This related sandbox and its data will be permanently removed.",
                      actionLabel: "Delete sandbox",
                      requiredName: sandbox.name,
                      run: () =>
                        action(
                          "lifecycle",
                          { type: "delete-related", confirmation: sandbox.name },
                          "Related sandbox deleted.",
                        ),
                    })
                  }
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-kumo-hairline ring ring-kumo-hairline sm:grid-cols-4">
            {[
              ["Status", sandbox.status],
              ["Kind", sandbox.kind],
              ["Region", sandbox.region ?? "—"],
              ["Runtime", sandbox.runtime ?? "—"],
              ["vCPUs", String(sandbox.vcpus ?? "—")],
              ["Memory", sandbox.memoryMb === null ? "—" : `${sandbox.memoryMb} MB`],
              ["Created", dateTime(sandbox.createdAt)],
              ["Expires", dateTime(sandbox.expiresAt)],
              ["Total CPU", durationLabel(sandbox.totalActiveCpuDurationMs)],
              ["Total duration", durationLabel(sandbox.totalDurationMs)],
              ["Ingress", sandbox.totalIngressBytes === null ? "—" : formatBytes(sandbox.totalIngressBytes)],
              ["Egress", sandbox.totalEgressBytes === null ? "—" : formatBytes(sandbox.totalEgressBytes)],
            ].map(([label, value]) => (
              <div key={label} className="bg-kumo-base p-3">
                <dt className="text-xs text-kumo-subtle">{label}</dt>
                <dd className="mt-1 truncate text-sm font-medium text-kumo-strong">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rounded-xl bg-kumo-base p-4 ring ring-kumo-hairline">
          <h3 className="text-balance text-sm font-semibold text-kumo-strong">
            Runtime configuration
          </h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="text-xs font-medium text-kumo-default">
              vCPUs
              <Input
                type="number"
                min={1}
                max={32}
                value={vcpus}
                className="mt-1.5 w-full"
                onChange={(event) => setVcpus(event.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-kumo-default">
              Timeout in minutes
              <Input
                type="number"
                min={1}
                max={1440}
                value={timeoutMinutes}
                className="mt-1.5 w-full"
                onChange={(event) => setTimeoutMinutes(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-kumo-default">
              <input
                type="checkbox"
                checked={persistent}
                className="size-4 accent-current"
                onChange={(event) => setPersistent(event.target.checked)}
              />
              Persistent sandbox
            </label>
          </div>
          <Button
            className="mt-4"
            size="sm"
            variant="primary"
            loading={loading}
            onClick={() =>
              void patch(
                {
                  vcpus: Number(vcpus),
                  timeoutMs: Number(timeoutMinutes) * 60_000,
                  persistent,
                },
                "Runtime configuration updated.",
              )
            }
          >
            Save runtime
          </Button>
        </section>

        <section className="rounded-xl bg-kumo-base p-4 ring ring-kumo-hairline">
          <h3 className="text-balance text-sm font-semibold text-kumo-strong">
            Snapshot retention
          </h3>
          <p className="mt-1 text-pretty text-xs text-kumo-subtle">
            Set zero minutes for snapshots that do not expire. Automatic retention keeps the
            newest snapshots after checkpoints.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="text-xs font-medium text-kumo-default">
              Default expiration in minutes
              <Input
                type="number"
                min={0}
                value={snapshotExpirationMinutes}
                className="mt-1.5 w-full"
                onChange={(event) => setSnapshotExpirationMinutes(event.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-kumo-default">
              Snapshots to keep
              <Input
                type="number"
                min={1}
                max={100}
                value={keepSnapshotCount}
                disabled={!keepSnapshots}
                className="mt-1.5 w-full"
                onChange={(event) => setKeepSnapshotCount(event.target.value)}
              />
            </label>
            <div className="space-y-2 self-end pb-2">
              <label className="flex items-center gap-2 text-sm text-kumo-default">
                <input
                  type="checkbox"
                  checked={keepSnapshots}
                  className="size-4 accent-current"
                  onChange={(event) => setKeepSnapshots(event.target.checked)}
                />
                Keep newest snapshots
              </label>
              <label className="flex items-center gap-2 text-sm text-kumo-default">
                <input
                  type="checkbox"
                  checked={deleteEvictedSnapshots}
                  disabled={!keepSnapshots}
                  className="size-4 accent-current"
                  onChange={(event) => setDeleteEvictedSnapshots(event.target.checked)}
                />
                Delete evicted snapshots
              </label>
            </div>
          </div>
          <Button
            className="mt-4"
            size="sm"
            variant="primary"
            loading={loading}
            onClick={() =>
              void patch(
                {
                  snapshotExpirationMs: Number(snapshotExpirationMinutes) * 60_000,
                  keepLastSnapshots: keepSnapshots
                    ? {
                        count: Number(keepSnapshotCount),
                        deleteEvicted: deleteEvictedSnapshots,
                      }
                    : null,
                },
                "Snapshot retention updated.",
              )
            }
          >
            Save retention
          </Button>
        </section>

        <section className="rounded-xl bg-kumo-base p-4 ring ring-kumo-hairline">
          <h3 className="text-balance text-sm font-semibold text-kumo-strong">
            Network policy
          </h3>
          <p className="mt-1 text-pretty text-xs text-kumo-subtle">
            Changes apply to outbound traffic. Existing credential and forwarding rules are shown
            below but are intentionally not exposed to the browser.
          </p>
          <div className="mt-4 flex flex-wrap gap-4">
            {(["allow-all", "deny-all", "custom"] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-2 text-sm text-kumo-default">
                <input
                  type="radio"
                  name="workspace-network-mode"
                  value={mode}
                  checked={networkMode === mode}
                  onChange={() => setNetworkMode(mode)}
                />
                {mode === "allow-all"
                  ? "Allow all"
                  : mode === "deny-all"
                    ? "Deny all"
                    : "Custom"}
              </label>
            ))}
          </div>
          {networkMode === "custom" && (
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <label className="text-xs font-medium text-kumo-default">
                Allowed domains
                <InputArea
                  value={allowedDomains}
                  rows={5}
                  className="mt-1.5 w-full font-mono text-xs"
                  placeholder={"api.example.com\n*.example.org"}
                  onChange={(event) => setAllowedDomains(event.target.value)}
                />
              </label>
              <label className="text-xs font-medium text-kumo-default">
                Allowed CIDRs
                <InputArea
                  value={allowedCidrs}
                  rows={5}
                  className="mt-1.5 w-full font-mono text-xs"
                  placeholder="203.0.113.0/24"
                  onChange={(event) => setAllowedCidrs(event.target.value)}
                />
              </label>
              <label className="text-xs font-medium text-kumo-default">
                Denied CIDRs
                <InputArea
                  value={deniedCidrs}
                  rows={5}
                  className="mt-1.5 w-full font-mono text-xs"
                  placeholder="10.0.0.0/8"
                  onChange={(event) => setDeniedCidrs(event.target.value)}
                />
              </label>
            </div>
          )}
          {sandbox.networkPolicy.mode === "custom" &&
            (sandbox.networkPolicy.credentialDomains.length > 0 ||
              sandbox.networkPolicy.forwardRules.length > 0) && (
              <div className="mt-4 rounded-lg bg-kumo-warning-tint/50 p-3 text-xs text-kumo-warning">
                Provider-managed rules: {sandbox.networkPolicy.credentialDomains.length} credential
                domain(s), {sandbox.networkPolicy.forwardRules.length} forwarding rule(s).
              </div>
            )}
          <Button
            className="mt-4"
            size="sm"
            variant="primary"
            loading={loading}
            onClick={() =>
              void patch(
                networkMode === "custom"
                  ? {
                      networkPolicy: {
                        mode: "custom",
                        allowedDomains: values(allowedDomains),
                        allowedCidrs: values(allowedCidrs),
                        deniedCidrs: values(deniedCidrs),
                      },
                    }
                  : { networkPolicy: { mode: networkMode } },
                "Network policy updated.",
              )
            }
          >
            Save network policy
          </Button>
        </section>

        <section>
          <h3 className="text-balance text-sm font-semibold text-kumo-strong">
            Related sandboxes
          </h3>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {overview.related.length === 0 ? (
              <p className="rounded-xl bg-kumo-base p-4 text-sm text-kumo-subtle ring ring-kumo-hairline">
                No forks or recovery backups.
              </p>
            ) : (
              overview.related.map((related) => (
                <div
                  key={related.name}
                  className="rounded-xl bg-kumo-base p-4 ring ring-kumo-hairline"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant={related.kind === "backup" ? "warning" : "info"}>
                          {related.kind}
                        </Badge>
                        {statusBadge(related.status)}
                      </div>
                      <p className="mt-2 truncate font-mono text-xs text-kumo-default">
                        {related.name}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="xs"
                        onClick={() =>
                          confirm({
                            title: `Promote this ${related.kind}?`,
                            description:
                              "The current root will be checkpointed to a recovery backup, then replaced with this sandbox.",
                            actionLabel: "Promote",
                            requiredName: related.name,
                            run: () =>
                              action(
                                "fork",
                                {
                                  type: "promote",
                                  sourceName: related.name,
                                  confirmation: related.name,
                                },
                                "Related sandbox promoted.",
                              ),
                          })
                        }
                      >
                        Promote
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary-destructive"
                        onClick={() =>
                          confirm({
                            title: `Delete this ${related.kind}?`,
                            description: "This sandbox and its data will be permanently removed.",
                            actionLabel: "Delete",
                            requiredName: related.name,
                            run: () =>
                              action(
                                "fork",
                                {
                                  type: "delete",
                                  sourceName: related.name,
                                  confirmation: related.name,
                                },
                                "Related sandbox deleted.",
                              ),
                          })
                        }
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section>
          <h3 className="text-balance text-sm font-semibold text-kumo-strong">Snapshots</h3>
          <div className="mt-3 overflow-x-auto rounded-xl bg-kumo-base ring ring-kumo-hairline">
            <table className="w-full min-w-2xl text-xs">
              <thead className="border-b border-kumo-hairline bg-kumo-tint text-kumo-subtle">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">Snapshot</th>
                  <th className="px-3 py-2 text-start font-medium">Created</th>
                  <th className="px-3 py-2 text-end font-medium">Size</th>
                  <th className="px-3 py-2 text-end font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-kumo-hairline">
                {overview.snapshots.map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td className="px-3 py-2">
                      <span className="font-mono">{snapshot.id}</span>
                      {snapshot.current && (
                        <Badge className="ms-2" variant="success">
                          current
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">{dateTime(snapshot.createdAt)}</td>
                    <td className="px-3 py-2 text-end tabular-nums">
                      {formatBytes(snapshot.sizeBytes)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        {!snapshot.current && (
                          <>
                            <Button
                              size="xs"
                              onClick={() =>
                                confirm({
                                  title: "Roll back to this snapshot?",
                                  description:
                                    "The current state will be checkpointed first, then this snapshot will become active.",
                                  actionLabel: "Roll back",
                                  requiredName: sandbox.name,
                                  run: () =>
                                    action(
                                      "snapshot",
                                      {
                                        type: "rollback",
                                        snapshotId: snapshot.id,
                                        confirmation: sandbox.name,
                                      },
                                      "Snapshot restored.",
                                    ),
                                })
                              }
                            >
                              Roll back
                            </Button>
                            <Button
                              size="xs"
                              variant="secondary-destructive"
                              onClick={() =>
                                confirm({
                                  title: "Delete this snapshot?",
                                  description: "This saved sandbox state will be permanently removed.",
                                  actionLabel: "Delete snapshot",
                                  requiredName: sandbox.name,
                                  run: () =>
                                    action(
                                      "snapshot",
                                      {
                                        type: "delete",
                                        snapshotId: snapshot.id,
                                        confirmation: sandbox.name,
                                      },
                                      "Snapshot deleted.",
                                    ),
                                })
                              }
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {overview.snapshots.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-kumo-subtle">
                      No snapshots yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h3 className="text-balance text-sm font-semibold text-kumo-strong">
            Session history
          </h3>
          <div className="mt-3 overflow-x-auto rounded-xl bg-kumo-base ring ring-kumo-hairline">
            <table className="w-full min-w-2xl text-xs">
              <thead className="border-b border-kumo-hairline bg-kumo-tint text-kumo-subtle">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">Session</th>
                  <th className="px-3 py-2 text-start font-medium">Status</th>
                  <th className="px-3 py-2 text-start font-medium">Started</th>
                  <th className="px-3 py-2 text-end font-medium">Duration</th>
                  <th className="px-3 py-2 text-end font-medium">CPU</th>
                  <th className="px-3 py-2 text-end font-medium">Transfer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-kumo-hairline">
                {overview.sessions.map((session) => (
                  <tr key={session.id}>
                    <td className="max-w-64 truncate px-3 py-2 font-mono">{session.id}</td>
                    <td className="px-3 py-2">{statusBadge(session.status)}</td>
                    <td className="px-3 py-2">{dateTime(session.startedAt)}</td>
                    <td className="px-3 py-2 text-end">{durationLabel(session.durationMs)}</td>
                    <td className="px-3 py-2 text-end">
                      {durationLabel(session.activeCpuDurationMs)}
                    </td>
                    <td className="px-3 py-2 text-end">
                      {session.ingressBytes === null || session.egressBytes === null
                        ? "—"
                        : formatBytes(session.ingressBytes + session.egressBytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
