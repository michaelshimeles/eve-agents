export const WORKSPACE_ROOT = "/workspace";
export const WORKSPACE_ADMIN_HEADER = "x-workspace-admin-token";
export const MAX_WORKSPACE_EDITOR_BYTES = 2 * 1024 * 1024;
export const MAX_WORKSPACE_TRANSFER_BYTES = 256 * 1024 * 1024;
export const MAX_WORKSPACE_PORTS = 15;

export type WorkspaceSandboxStatus =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "aborted"
  | "snapshotting";

export type WorkspaceKind = "root" | "generation" | "fork" | "backup";

export interface WorkspaceTarget {
  sessionId: string;
  targetName?: string;
}

export interface WorkspaceRoute {
  port: number;
  url: string;
}

export interface WorkspaceSandboxSummary {
  name: string;
  kind: WorkspaceKind;
  status: WorkspaceSandboxStatus;
  persistent: boolean;
  createdAt: string;
  updatedAt: string;
  statusUpdatedAt: string | null;
  expiresAt: string | null;
  region: string | null;
  vcpus: number | null;
  memoryMb: number | null;
  runtime: string | null;
  image: string | null;
  timeoutMs: number | null;
  currentSnapshotId: string | null;
  snapshotExpirationMs: number | null;
  keepLastSnapshots: {
    count: number;
    expirationMs: number | null;
    deleteEvicted: boolean;
  } | null;
  totalIngressBytes: number | null;
  totalEgressBytes: number | null;
  totalActiveCpuDurationMs: number | null;
  totalDurationMs: number | null;
  tags: Record<string, string>;
  networkPolicy: WorkspaceNetworkPolicyView;
  routes: WorkspaceRoute[];
}

export type WorkspaceNetworkPolicyView =
  | { mode: "allow-all" }
  | { mode: "deny-all" }
  | {
      mode: "custom";
      allowedDomains: string[];
      allowedCidrs: string[];
      deniedCidrs: string[];
      credentialDomains: string[];
      forwardRules: { domain: string; forwardUrl: string }[];
    };

export interface WorkspaceSessionSummary {
  id: string;
  status: WorkspaceSandboxStatus;
  region: string;
  runtime: string;
  vcpus: number;
  memoryMb: number;
  timeoutMs: number;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  durationMs: number | null;
  activeCpuDurationMs: number | null;
  ingressBytes: number | null;
  egressBytes: number | null;
  sourceSnapshotId: string | null;
}

export interface WorkspaceSnapshotSummary {
  id: string;
  status: "failed" | "created" | "deleted";
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  sourceSessionId: string;
  parentId: string | null;
  current: boolean;
}

export interface WorkspaceOverview {
  state: "not_started" | "ready";
  root: WorkspaceSandboxSummary | null;
  target: WorkspaceSandboxSummary | null;
  generations: WorkspaceSandboxSummary[];
  related: WorkspaceSandboxSummary[];
  sessions: WorkspaceSessionSummary[];
  snapshots: WorkspaceSnapshotSummary[];
  devTerminalUrl: string | null;
  warning: string;
}

export type WorkspaceEntryKind = "file" | "directory" | "symlink" | "other";

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  size: number;
  mode: number;
  modifiedAt: string;
  version: string;
  symlinkTarget: string | null;
  externalSymlink: boolean;
}

export interface WorkspaceDirectory {
  path: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceTextFile {
  path: string;
  content: string;
  size: number;
  modifiedAt: string;
  version: string;
  mode: number;
}

export interface WorkspaceProcess {
  pid: number;
  ppid: number;
  user: string;
  state: string;
  elapsedSeconds: number;
  cpuPercent: number;
  memoryPercent: number;
  command: string;
}

export type WorkspaceFsAction =
  | { type: "create-file"; path: string }
  | { type: "create-directory"; path: string }
  | { type: "rename"; path: string; destination: string }
  | { type: "copy"; path: string; destination: string }
  | { type: "chmod"; path: string; mode: number }
  | { type: "symlink"; path: string; target: string }
  | { type: "delete"; path: string; recursive?: boolean };

export type WorkspaceLifecycleAction =
  | { type: "resume" }
  | { type: "stop" }
  | { type: "reset"; confirmation: string; keepBackup: boolean }
  | { type: "delete-related"; confirmation: string };

export type WorkspaceSnapshotAction =
  | { type: "create"; expirationMs?: number }
  | { type: "rollback"; snapshotId: string; confirmation: string }
  | { type: "delete"; snapshotId: string; confirmation: string };

export type WorkspaceForkAction =
  | { type: "create"; label?: string }
  | { type: "promote"; sourceName: string; confirmation: string }
  | { type: "delete"; sourceName: string; confirmation: string };

export interface WorkspaceConfigPatch {
  vcpus?: number;
  timeoutMs?: number;
  persistent?: boolean;
  ports?: number[];
  snapshotExpirationMs?: number;
  keepLastSnapshots?: {
    count: number;
    expirationMs?: number;
    deleteEvicted?: boolean;
  } | null;
  networkPolicy?:
    | { mode: "allow-all" }
    | { mode: "deny-all" }
    | {
        mode: "custom";
        allowedDomains: string[];
        allowedCidrs: string[];
        deniedCidrs: string[];
      };
}

export class WorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly authRequired = false,
    readonly authConfigured = false,
  ) {
    super(message);
    this.name = "WorkspaceApiError";
  }
}

export async function workspaceJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => null)) as
    | {
        error?: string;
        authRequired?: boolean;
        authConfigured?: boolean;
      }
    | T
    | null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : "Workspace request failed.";
    throw new WorkspaceApiError(
      message,
      response.status,
      body !== null &&
        typeof body === "object" &&
        "authRequired" in body &&
        body.authRequired === true,
      body !== null &&
        typeof body === "object" &&
        "authConfigured" in body &&
        body.authConfigured === true,
    );
  }
  return body as T;
}
