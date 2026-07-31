import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";

import { Sandbox, Snapshot, type NetworkPolicy } from "@vercel/sandbox";
import { Context, Data, Effect, Layer, Schema } from "effect";

import {
  MAX_WORKSPACE_EDITOR_BYTES,
  MAX_WORKSPACE_PORTS,
  MAX_WORKSPACE_TRANSFER_BYTES,
  WORKSPACE_ROOT,
  type WorkspaceConfigPatch,
  type WorkspaceDirectory,
  type WorkspaceEntry,
  type WorkspaceForkAction,
  type WorkspaceFsAction,
  type WorkspaceLifecycleAction,
  type WorkspaceNetworkPolicyView,
  type WorkspaceOverview,
  type WorkspaceProcess,
  type WorkspaceSandboxStatus,
  type WorkspaceSandboxSummary,
  type WorkspaceSessionSummary,
  type WorkspaceSnapshotAction,
  type WorkspaceSnapshotSummary,
  type WorkspaceTarget,
  type WorkspaceTextFile,
} from "@/lib/workspace-api";

export const WorkspaceTargetInput = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  targetName: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
});

const WorkspacePathInput = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
);
const WorkspaceStringListInput = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
).check(Schema.isMaxLength(256));

export const WorkspaceFsActionInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("create-file"), path: WorkspacePathInput }),
  Schema.Struct({ type: Schema.Literal("create-directory"), path: WorkspacePathInput }),
  Schema.Struct({
    type: Schema.Literal("rename"),
    path: WorkspacePathInput,
    destination: WorkspacePathInput,
  }),
  Schema.Struct({
    type: Schema.Literal("copy"),
    path: WorkspacePathInput,
    destination: WorkspacePathInput,
  }),
  Schema.Struct({
    type: Schema.Literal("chmod"),
    path: WorkspacePathInput,
    mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0o7777 })),
  }),
  Schema.Struct({
    type: Schema.Literal("symlink"),
    path: WorkspacePathInput,
    target: WorkspacePathInput,
  }),
  Schema.Struct({
    type: Schema.Literal("delete"),
    path: WorkspacePathInput,
    recursive: Schema.optionalKey(Schema.Boolean),
  }),
]);

export const WorkspaceLifecycleActionInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("resume") }),
  Schema.Struct({ type: Schema.Literal("stop") }),
  Schema.Struct({
    type: Schema.Literal("reset"),
    confirmation: Schema.String,
    keepBackup: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("delete-related"),
    confirmation: Schema.String,
  }),
]);

export const WorkspaceSnapshotActionInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    expirationMs: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("rollback"),
    snapshotId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    confirmation: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("delete"),
    snapshotId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    confirmation: Schema.String,
  }),
]);

export const WorkspaceForkActionInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  }),
  Schema.Struct({
    type: Schema.Literal("promote"),
    sourceName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    confirmation: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("delete"),
    sourceName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    confirmation: Schema.String,
  }),
]);

const WorkspaceNetworkPolicyInput = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("allow-all") }),
  Schema.Struct({ mode: Schema.Literal("deny-all") }),
  Schema.Struct({
    mode: Schema.Literal("custom"),
    allowedDomains: WorkspaceStringListInput,
    allowedCidrs: WorkspaceStringListInput,
    deniedCidrs: WorkspaceStringListInput,
  }),
]);

export const WorkspaceConfigPatchInput = Schema.Struct({
  vcpus: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  ),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 60_000, maximum: 86_400_000 })),
  ),
  persistent: Schema.optionalKey(Schema.Boolean),
  ports: Schema.optionalKey(
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
    ).check(Schema.isMaxLength(MAX_WORKSPACE_PORTS)),
  ),
  snapshotExpirationMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  keepLastSnapshots: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
        expirationMs: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        ),
        deleteEvicted: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  networkPolicy: Schema.optionalKey(WorkspaceNetworkPolicyInput),
});

export class SandboxWorkspaceError extends Data.TaggedError("SandboxWorkspaceError")<{
  readonly kind:
    | "invalid"
    | "not_started"
    | "not_found"
    | "conflict"
    | "too_large"
    | "credentials"
    | "provider";
  readonly message: string;
  readonly operation: string;
}> {}

export interface WorkspaceUploadHandle {
  readonly append: (chunk: Uint8Array) => Effect.Effect<void, SandboxWorkspaceError>;
  readonly commit: () => Effect.Effect<void, SandboxWorkspaceError>;
  readonly abort: () => Effect.Effect<void, SandboxWorkspaceError>;
}

export function sandboxWorkspaceErrorStatus(error: SandboxWorkspaceError): number {
  switch (error.kind) {
    case "invalid":
      return 400;
    case "not_started":
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "too_large":
      return 413;
    case "credentials":
      return 503;
    case "provider":
      return 502;
  }
}

interface ListedSandbox {
  name: string;
  persistent: boolean;
  createdAt: number;
  updatedAt: number;
  currentSessionId: string;
  status: WorkspaceSandboxStatus;
  region?: string;
  vcpus?: number;
  memory?: number;
  runtime?: string;
  image?: string;
  timeout?: number;
  networkPolicy?: Record<string, unknown> & { mode?: string };
  totalEgressBytes?: number;
  totalIngressBytes?: number;
  totalActiveCpuDurationMs?: number;
  totalDurationMs?: number;
  expiresAt?: number;
  currentSnapshotId?: string;
  statusUpdatedAt?: number;
  cwd?: string;
  tags?: Record<string, string>;
  snapshotExpiration?: number;
  keepLastSnapshots?: {
    count: number;
    expiration?: number;
    deleteEvicted?: boolean;
  };
}

const ACTIVE_STATUSES = new Set<WorkspaceSandboxStatus>(["running", "pending"]);
const RELATED_KINDS = new Set(["fork", "backup"]);
const EXTERNAL_LINK_SENTINEL = "__external__";
const SANDBOX_LIST_PAGE_LIMIT = 50;

function workspaceError(
  kind: SandboxWorkspaceError["kind"],
  operation: string,
  message: string,
): SandboxWorkspaceError {
  return new SandboxWorkspaceError({ kind, operation, message });
}

function decodeWorkspaceInput<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  operation: string,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw workspaceError("invalid", operation, "The workspace request is invalid.");
  }
}

export function decodeWorkspaceFsAction(value: unknown): WorkspaceFsAction {
  return decodeWorkspaceInput(WorkspaceFsActionInput, value, "validate the filesystem action");
}

export function decodeWorkspaceLifecycleAction(value: unknown): WorkspaceLifecycleAction {
  return decodeWorkspaceInput(
    WorkspaceLifecycleActionInput,
    value,
    "validate the lifecycle action",
  );
}

export function decodeWorkspaceSnapshotAction(value: unknown): WorkspaceSnapshotAction {
  return decodeWorkspaceInput(
    WorkspaceSnapshotActionInput,
    value,
    "validate the snapshot action",
  );
}

export function decodeWorkspaceForkAction(value: unknown): WorkspaceForkAction {
  return decodeWorkspaceInput(WorkspaceForkActionInput, value, "validate the fork action");
}

export function decodeWorkspaceConfigPatch(value: unknown): WorkspaceConfigPatch {
  const decoded = decodeWorkspaceInput(
    WorkspaceConfigPatchInput,
    value,
    "validate the workspace configuration",
  );
  if (
    decoded.ports !== undefined &&
    new Set(decoded.ports).size !== decoded.ports.length
  ) {
    throw workspaceError("invalid", "validate the workspace configuration", "Ports must be unique.");
  }
  return {
    ...decoded,
    ports: decoded.ports === undefined ? undefined : [...decoded.ports],
    networkPolicy:
      decoded.networkPolicy === undefined
        ? undefined
        : decoded.networkPolicy.mode !== "custom"
          ? decoded.networkPolicy
          : {
              ...decoded.networkPolicy,
              allowedDomains: [...decoded.networkPolicy.allowedDomains],
              allowedCidrs: [...decoded.networkPolicy.allowedCidrs],
              deniedCidrs: [...decoded.networkPolicy.deniedCidrs],
            },
  };
}

function classifyProviderError(operation: string, cause: unknown): SandboxWorkspaceError {
  if (cause instanceof SandboxWorkspaceError) return cause;
  const raw = cause instanceof Error ? cause.message : String(cause);
  const message = raw.toLowerCase();
  if (
    message.includes("credential") ||
    message.includes("oidc") ||
    message.includes("vercel_token")
  ) {
    return workspaceError(
      "credentials",
      operation,
      "Vercel Sandbox credentials are not available for this deployment.",
    );
  }
  if (message.includes("not found") || message.includes("404")) {
    return workspaceError("not_found", operation, "The selected sandbox no longer exists.");
  }
  if (message.includes("already exists") || message.includes("conflict") || message.includes("409")) {
    return workspaceError("conflict", operation, "The workspace changed before this action completed.");
  }
  if (message.includes("too large") || message.includes("payload")) {
    return workspaceError("too_large", operation, "The requested workspace transfer is too large.");
  }
  return workspaceError("provider", operation, `Vercel Sandbox could not ${operation}.`);
}

function providerEffect<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, SandboxWorkspaceError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => classifyProviderError(operation, cause),
  });
}

function invalid(operation: string, message: string): Effect.Effect<never, SandboxWorkspaceError> {
  return Effect.fail(workspaceError("invalid", operation, message));
}

function iso(value: number | Date | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

function sanitizeLabel(label: string | undefined): string {
  const normalized = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return normalized.length > 0 ? normalized : Date.now().toString(36);
}

export function normalizeWorkspacePath(input: string): string {
  if (input.includes("\0")) {
    throw workspaceError("invalid", "resolve a path", "Workspace paths cannot contain NUL bytes.");
  }
  const absolute = input.startsWith("/")
    ? posix.normalize(input)
    : posix.resolve(WORKSPACE_ROOT, input);
  if (absolute !== WORKSPACE_ROOT && !absolute.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw workspaceError(
      "invalid",
      "resolve a path",
      "The visual workspace is limited to /workspace.",
    );
  }
  return absolute;
}

function entryVersion(stats: { size: number; mtimeMs: number; ino: number }): string {
  return createHash("sha256")
    .update(`${stats.size}:${stats.mtimeMs}:${stats.ino}`)
    .digest("hex")
    .slice(0, 24);
}

function networkPolicyView(
  policy:
    | NetworkPolicy
    | (Record<string, unknown> & { mode?: string })
    | undefined,
): WorkspaceNetworkPolicyView {
  if (policy === undefined) return { mode: "allow-all" };
  if (policy === "allow-all" || policy === "deny-all") return { mode: policy };
  if ("mode" in policy) {
    if (policy.mode === "allow-all" || policy.mode === "deny-all") {
      return { mode: policy.mode };
    }
    const allowedDomains = Array.isArray(policy.allowedDomains)
      ? policy.allowedDomains.filter((value): value is string => typeof value === "string")
      : [];
    const allowedCidrs = Array.isArray(policy.allowedCIDRs)
      ? policy.allowedCIDRs.filter((value): value is string => typeof value === "string")
      : [];
    const deniedCidrs = Array.isArray(policy.deniedCIDRs)
      ? policy.deniedCIDRs.filter((value): value is string => typeof value === "string")
      : [];
    const injectionRules = Array.isArray(policy.injectionRules) ? policy.injectionRules : [];
    const forwardRules = Array.isArray(policy.forwardRules) ? policy.forwardRules : [];
    return {
      mode: "custom",
      allowedDomains,
      allowedCidrs,
      deniedCidrs,
      credentialDomains: injectionRules.flatMap((rule) => {
        if (rule && typeof rule === "object" && "domain" in rule && typeof rule.domain === "string") {
          return [rule.domain];
        }
        return [];
      }),
      forwardRules: forwardRules.flatMap((rule) => {
        if (
          rule &&
          typeof rule === "object" &&
          "domain" in rule &&
          "forwardURL" in rule &&
          typeof rule.domain === "string" &&
          typeof rule.forwardURL === "string"
        ) {
          return [{ domain: rule.domain, forwardUrl: rule.forwardURL }];
        }
        return [];
      }),
    };
  }
  const allow = policy.allow;
  const allowedDomains = Array.isArray(allow)
    ? allow
    : allow && typeof allow === "object"
      ? Object.keys(allow)
      : [];
  const credentialDomains =
    allow && !Array.isArray(allow) && typeof allow === "object"
      ? Object.entries(allow).flatMap(([domain, rules]) =>
          Array.isArray(rules) && rules.some((rule) => "transform" in rule) ? [domain] : [],
        )
      : [];
  const forwardRules =
    allow && !Array.isArray(allow) && typeof allow === "object"
      ? Object.entries(allow).flatMap(([domain, rules]) =>
          Array.isArray(rules)
            ? rules.flatMap((rule) =>
                "forwardURL" in rule && typeof rule.forwardURL === "string"
                  ? [{ domain, forwardUrl: rule.forwardURL }]
                  : [],
              )
            : [],
        )
      : [];
  const subnetPolicy = policy as Extract<NetworkPolicy, object>;
  return {
    mode: "custom",
    allowedDomains,
    allowedCidrs: subnetPolicy.subnets?.allow ?? [],
    deniedCidrs: subnetPolicy.subnets?.deny ?? [],
    credentialDomains,
    forwardRules,
  };
}

function kindFromTags(
  tags: Record<string, string> | undefined,
  rootName: string | undefined,
  name: string,
): WorkspaceSandboxSummary["kind"] {
  if (tags?.ruthKind === "fork" || tags?.ruthKind === "backup") return tags.ruthKind;
  return rootName === undefined || rootName === name ? "root" : "generation";
}

function listedSummary(
  sandbox: ListedSandbox,
  rootName?: string,
): WorkspaceSandboxSummary {
  return {
    name: sandbox.name,
    kind: kindFromTags(sandbox.tags, rootName, sandbox.name),
    status: sandbox.status,
    persistent: sandbox.persistent,
    createdAt: iso(sandbox.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(sandbox.updatedAt) ?? new Date(0).toISOString(),
    statusUpdatedAt: iso(sandbox.statusUpdatedAt),
    expiresAt: iso(sandbox.expiresAt),
    region: sandbox.region ?? null,
    vcpus: sandbox.vcpus ?? null,
    memoryMb: sandbox.memory ?? null,
    runtime: sandbox.runtime ?? null,
    image: sandbox.image ?? null,
    timeoutMs: sandbox.timeout ?? null,
    currentSnapshotId: sandbox.currentSnapshotId ?? null,
    snapshotExpirationMs: sandbox.snapshotExpiration ?? null,
    keepLastSnapshots: sandbox.keepLastSnapshots
      ? {
          count: sandbox.keepLastSnapshots.count,
          expirationMs: sandbox.keepLastSnapshots.expiration ?? null,
          deleteEvicted: sandbox.keepLastSnapshots.deleteEvicted ?? true,
        }
      : null,
    totalIngressBytes: sandbox.totalIngressBytes ?? null,
    totalEgressBytes: sandbox.totalEgressBytes ?? null,
    totalActiveCpuDurationMs: sandbox.totalActiveCpuDurationMs ?? null,
    totalDurationMs: sandbox.totalDurationMs ?? null,
    tags: sandbox.tags ?? {},
    networkPolicy: networkPolicyView(sandbox.networkPolicy),
    routes: [],
  };
}

function liveSummary(
  sandbox: Sandbox,
  kind: WorkspaceSandboxSummary["kind"],
): WorkspaceSandboxSummary {
  return {
    name: sandbox.name,
    kind,
    status: sandbox.status,
    persistent: sandbox.persistent,
    createdAt: sandbox.createdAt.toISOString(),
    updatedAt: sandbox.updatedAt.toISOString(),
    statusUpdatedAt: iso(sandbox.statusUpdatedAt),
    expiresAt: iso(sandbox.expiresAt),
    region: sandbox.region ?? null,
    vcpus: sandbox.vcpus ?? null,
    memoryMb: sandbox.memory ?? null,
    runtime: sandbox.runtime ?? null,
    image: sandbox.image ?? null,
    timeoutMs: sandbox.timeout ?? null,
    currentSnapshotId: sandbox.currentSnapshotId ?? null,
    snapshotExpirationMs: sandbox.snapshotExpiration ?? null,
    keepLastSnapshots: sandbox.keepLastSnapshots
      ? {
          count: sandbox.keepLastSnapshots.count,
          expirationMs: sandbox.keepLastSnapshots.expiration ?? null,
          deleteEvicted: sandbox.keepLastSnapshots.deleteEvicted ?? true,
        }
      : null,
    totalIngressBytes: sandbox.totalIngressBytes ?? null,
    totalEgressBytes: sandbox.totalEgressBytes ?? null,
    totalActiveCpuDurationMs: sandbox.totalActiveCpuDurationMs ?? null,
    totalDurationMs: sandbox.totalDurationMs ?? null,
    tags: sandbox.tags ?? {},
    networkPolicy: networkPolicyView(sandbox.networkPolicy),
    routes: sandbox.routes.map((route) => ({ port: route.port, url: route.url })),
  };
}

function sortRootCandidates(candidates: ListedSandbox[]): ListedSandbox[] {
  return candidates.toSorted((left, right) => {
    const active = Number(ACTIVE_STATUSES.has(right.status)) - Number(ACTIVE_STATUSES.has(left.status));
    if (active !== 0) return active;
    return (right.statusUpdatedAt ?? right.updatedAt) - (left.statusUpdatedAt ?? left.updatedAt);
  });
}

async function listSandboxesByTags(tags: Record<string, string>): Promise<ListedSandbox[]> {
  const page = await Sandbox.list({
    tags,
    sortBy: "statusUpdatedAt",
    sortOrder: "desc",
    limit: SANDBOX_LIST_PAGE_LIMIT,
  });
  return (await page.toArray()) as unknown as ListedSandbox[];
}

async function resolveSandboxes(target: WorkspaceTarget): Promise<{
  root: ListedSandbox | null;
  roots: ListedSandbox[];
  related: ListedSandbox[];
  selected: ListedSandbox | null;
}> {
  const [rootsRaw, relatedRaw] = await Promise.all([
    listSandboxesByTags({ sessionId: target.sessionId }),
    listSandboxesByTags({ ruthSession: sessionHash(target.sessionId) }),
  ]);
  const roots = sortRootCandidates(
    rootsRaw.filter((sandbox) => !RELATED_KINDS.has(sandbox.tags?.ruthKind ?? "")),
  );
  const related = relatedRaw.filter((sandbox) =>
    RELATED_KINDS.has(sandbox.tags?.ruthKind ?? ""),
  );
  const root = roots[0] ?? null;
  if (target.targetName === undefined) return { root, roots, related, selected: root };
  const selected =
    [...roots, ...related].find((sandbox) => sandbox.name === target.targetName) ?? null;
  return { root, roots, related, selected };
}

async function resolveLiveSandbox(
  target: WorkspaceTarget,
  resume: boolean,
): Promise<{
  sandbox: Sandbox;
  root: ListedSandbox;
  selected: ListedSandbox;
  roots: ListedSandbox[];
  related: ListedSandbox[];
}> {
  const resolved = await resolveSandboxes(target);
  if (resolved.root === null) {
    throw workspaceError(
      "not_started",
      "open the workspace",
      "This conversation has not used its workspace yet.",
    );
  }
  if (resolved.selected === null) {
    throw workspaceError("not_found", "open the workspace", "The selected workspace was not found.");
  }
  const sandbox = await Sandbox.get({ name: resolved.selected.name, resume });
  return {
    sandbox,
    root: resolved.root,
    selected: resolved.selected,
    roots: resolved.roots,
    related: resolved.related,
  };
}

async function assertInWorkspace(sandbox: Sandbox, path: string, forWrite = false): Promise<string> {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === WORKSPACE_ROOT) return normalized;
  const check = forWrite ? posix.dirname(normalized) : normalized;
  try {
    const real = await sandbox.fs.realpath(check);
    if (real !== WORKSPACE_ROOT && !real.startsWith(`${WORKSPACE_ROOT}/`)) {
      throw workspaceError(
        "invalid",
        "resolve a path",
        "That path resolves outside /workspace.",
      );
    }
  } catch (cause) {
    if (cause instanceof SandboxWorkspaceError) throw cause;
    if (!forWrite) throw cause;
    const parent = posix.dirname(check);
    if (parent !== check) await assertInWorkspace(sandbox, parent, true);
  }
  return normalized;
}

async function mapEntry(sandbox: Sandbox, parent: string, name: string): Promise<WorkspaceEntry> {
  const path = normalizeWorkspacePath(posix.join(parent, name));
  const stats = await sandbox.fs.lstat(path);
  let kind: WorkspaceEntry["kind"] = "other";
  if (stats.isFile()) kind = "file";
  else if (stats.isDirectory()) kind = "directory";
  else if (stats.isSymbolicLink()) kind = "symlink";
  let symlinkTarget: string | null = null;
  let externalSymlink = false;
  if (kind === "symlink") {
    symlinkTarget = await sandbox.fs.readlink(path);
    try {
      const real = await sandbox.fs.realpath(path);
      externalSymlink = real !== WORKSPACE_ROOT && !real.startsWith(`${WORKSPACE_ROOT}/`);
    } catch {
      externalSymlink = symlinkTarget === EXTERNAL_LINK_SENTINEL;
    }
  }
  return {
    name,
    path,
    kind,
    size: stats.size,
    mode: stats.mode & 0o7777,
    modifiedAt: stats.mtime.toISOString(),
    version: entryVersion(stats),
    symlinkTarget,
    externalSymlink,
  };
}

async function directory(sandbox: Sandbox, path: string): Promise<WorkspaceDirectory> {
  const normalized = await assertInWorkspace(sandbox, path);
  const names = await sandbox.fs.readdir(normalized);
  if (names.length > 2_000) {
    throw workspaceError(
      "too_large",
      "list the directory",
      "This directory has more than 2,000 entries. Use the terminal to narrow it.",
    );
  }
  const entries = await Promise.all(names.map((name) => mapEntry(sandbox, normalized, name)));
  entries.sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") return -1;
    if (right.kind === "directory" && left.kind !== "directory") return 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return { path: normalized, entries };
}

async function readText(sandbox: Sandbox, path: string): Promise<WorkspaceTextFile> {
  const normalized = await assertInWorkspace(sandbox, path);
  const stats = await sandbox.fs.stat(normalized);
  if (!stats.isFile()) {
    throw workspaceError("invalid", "read the file", "Only regular files can be edited.");
  }
  if (stats.size > MAX_WORKSPACE_EDITOR_BYTES) {
    throw workspaceError(
      "too_large",
      "read the file",
      "Files larger than 2 MiB are preview or download only.",
    );
  }
  const content = await sandbox.fs.readFile(normalized);
  if (content.subarray(0, 8_192).includes(0)) {
    throw workspaceError("invalid", "read the file", "Binary files cannot be opened in the editor.");
  }
  return {
    path: normalized,
    content: content.toString("utf8"),
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    version: entryVersion(stats),
    mode: stats.mode & 0o7777,
  };
}

async function writeText(
  sandbox: Sandbox,
  input: { path: string; content: string; expectedVersion?: string },
): Promise<WorkspaceTextFile> {
  const normalized = await assertInWorkspace(sandbox, input.path, true);
  const bytes = Buffer.byteLength(input.content);
  if (bytes > MAX_WORKSPACE_EDITOR_BYTES) {
    throw workspaceError("too_large", "save the file", "Editor saves are limited to 2 MiB.");
  }
  if (input.expectedVersion !== undefined && (await sandbox.fs.exists(normalized))) {
    const current = await sandbox.fs.lstat(normalized);
    if (entryVersion(current) !== input.expectedVersion) {
      throw workspaceError(
        "conflict",
        "save the file",
        "The file changed in the sandbox. Reload it or save under another name.",
      );
    }
  }
  await sandbox.fs.writeFile(normalized, input.content, "utf8");
  return readText(sandbox, normalized);
}

async function openUpload(
  target: WorkspaceTarget,
  input: { path: string; size: number; overwrite: boolean },
): Promise<WorkspaceUploadHandle> {
  if (
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    input.size > MAX_WORKSPACE_TRANSFER_BYTES
  ) {
    throw workspaceError(
      "too_large",
      "start the upload",
      "Workspace uploads are limited to 256 MiB.",
    );
  }
  const { sandbox } = await resolveLiveSandbox(target, true);
  const path = await assertInWorkspace(sandbox, input.path, true);
  if (path === WORKSPACE_ROOT) {
    throw workspaceError("invalid", "start the upload", "Choose a file path inside /workspace.");
  }
  if (!input.overwrite && (await sandbox.fs.exists(path))) {
    throw workspaceError("conflict", "start the upload", "A file already exists at that path.");
  }
  const temp = posix.join(
    posix.dirname(path),
    `.${posix.basename(path)}.ruth-upload-${randomUUID()}.part`,
  );
  await sandbox.fs.writeFile(temp, Buffer.alloc(0));
  let written = 0;
  let settled = false;

  const append = (chunk: Uint8Array): Effect.Effect<void, SandboxWorkspaceError> =>
    providerEffect("write the upload", async () => {
      if (settled) {
        throw workspaceError("conflict", "write the upload", "This upload is already complete.");
      }
      if (chunk.byteLength === 0 || written + chunk.byteLength > input.size) {
        throw workspaceError("invalid", "write the upload", "The upload chunk size is invalid.");
      }
      await sandbox.fs.appendFile(temp, chunk);
      written += chunk.byteLength;
    });

  const abort = (): Effect.Effect<void, SandboxWorkspaceError> =>
    providerEffect("abort the upload", async () => {
      if (settled) return;
      settled = true;
      await sandbox.fs.rm(temp, { force: true });
    });

  const commit = (): Effect.Effect<void, SandboxWorkspaceError> =>
    providerEffect("finish the upload", async () => {
      if (settled) {
        throw workspaceError("conflict", "finish the upload", "This upload is already complete.");
      }
      if (written !== input.size) {
        throw workspaceError(
          "conflict",
          "finish the upload",
          `The upload ended at ${written} of ${input.size} bytes.`,
        );
      }
      if (input.overwrite && (await sandbox.fs.exists(path))) {
        await sandbox.fs.rm(path, { force: true });
      }
      await sandbox.fs.rename(temp, path);
      settled = true;
    });

  return { append, abort, commit };
}

async function mutateFs(sandbox: Sandbox, action: WorkspaceFsAction): Promise<void> {
  const path = normalizeWorkspacePath(action.path);
  if (action.type === "create-file") {
    await assertInWorkspace(sandbox, path, true);
    if (await sandbox.fs.exists(path)) {
      throw workspaceError("conflict", "create the file", "A file already exists at that path.");
    }
    await sandbox.fs.writeFile(path, "");
    return;
  }
  if (action.type === "create-directory") {
    await assertInWorkspace(sandbox, path, true);
    await sandbox.fs.mkdir(path, { recursive: false });
    return;
  }
  if (action.type === "rename") {
    const destination = normalizeWorkspacePath(action.destination);
    await assertInWorkspace(sandbox, path);
    await assertInWorkspace(sandbox, destination, true);
    if (await sandbox.fs.exists(destination)) {
      throw workspaceError("conflict", "rename the entry", "The destination already exists.");
    }
    await sandbox.fs.rename(path, destination);
    return;
  }
  if (action.type === "copy") {
    const destination = normalizeWorkspacePath(action.destination);
    await assertInWorkspace(sandbox, path);
    await assertInWorkspace(sandbox, destination, true);
    if (await sandbox.fs.exists(destination)) {
      throw workspaceError("conflict", "copy the entry", "The destination already exists.");
    }
    const result = await sandbox.runCommand({
      cmd: "cp",
      args: ["-a", "--", path, destination],
    });
    if (result.exitCode !== 0) {
      throw workspaceError("provider", "copy the entry", "The sandbox could not copy that entry.");
    }
    return;
  }
  if (action.type === "chmod") {
    await assertInWorkspace(sandbox, path);
    if (!Number.isSafeInteger(action.mode) || action.mode < 0 || action.mode > 0o7777) {
      throw workspaceError("invalid", "change permissions", "Use an octal mode from 0000 to 7777.");
    }
    await sandbox.fs.chmod(path, action.mode);
    return;
  }
  if (action.type === "symlink") {
    const target = normalizeWorkspacePath(
      action.target.startsWith("/")
        ? action.target
        : posix.resolve(posix.dirname(path), action.target),
    );
    await assertInWorkspace(sandbox, path, true);
    if (await sandbox.fs.exists(path)) {
      throw workspaceError("conflict", "create the symlink", "An entry already exists at that path.");
    }
    await sandbox.fs.symlink(target, path);
    return;
  }
  if (path === WORKSPACE_ROOT) {
    throw workspaceError("invalid", "delete the entry", "The /workspace root cannot be deleted.");
  }
  await assertInWorkspace(sandbox, path);
  await sandbox.fs.rm(path, { force: false, recursive: action.recursive ?? false });
}

async function processList(sandbox: Sandbox): Promise<WorkspaceProcess[]> {
  const result = await sandbox.runCommand({
    cmd: "ps",
    args: ["-eo", "pid=,ppid=,user=,stat=,etimes=,pcpu=,pmem=,args="],
  });
  if (result.exitCode !== 0) {
    throw workspaceError("provider", "list processes", "The sandbox process list is unavailable.");
  }
  const stdout = await result.stdout();
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(
        /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/,
      );
      if (!match) return [];
      return [
        {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          user: match[3],
          state: match[4],
          elapsedSeconds: Number(match[5]),
          cpuPercent: Number(match[6]),
          memoryPercent: Number(match[7]),
          command: match[8],
        },
      ];
    });
}

async function signalProcess(
  sandbox: Sandbox,
  pid: number,
  signal: "TERM" | "KILL",
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw workspaceError("invalid", "signal the process", "PID 1 and invalid PIDs are protected.");
  }
  const result = await sandbox.runCommand({
    cmd: "kill",
    args: [`-${signal}`, String(pid)],
  });
  if (result.exitCode !== 0) {
    throw workspaceError("not_found", "signal the process", "That process is no longer running.");
  }
}

function toNetworkPolicy(
  patch: NonNullable<WorkspaceConfigPatch["networkPolicy"]>,
): NetworkPolicy {
  if (patch.mode === "allow-all" || patch.mode === "deny-all") return patch.mode;
  return {
    allow: patch.allowedDomains,
    subnets: {
      allow: patch.allowedCidrs,
      deny: patch.deniedCidrs,
    },
  };
}

async function updateConfig(sandbox: Sandbox, patch: WorkspaceConfigPatch): Promise<void> {
  if (patch.vcpus !== undefined && (!Number.isSafeInteger(patch.vcpus) || patch.vcpus < 1 || patch.vcpus > 32)) {
    throw workspaceError("invalid", "update resources", "vCPUs must be an integer from 1 to 32.");
  }
  if (
    patch.timeoutMs !== undefined &&
    (!Number.isSafeInteger(patch.timeoutMs) || patch.timeoutMs < 60_000 || patch.timeoutMs > 86_400_000)
  ) {
    throw workspaceError("invalid", "update the timeout", "Timeout must be from 1 minute to 24 hours.");
  }
  if (patch.ports !== undefined) {
    const ports = new Set(patch.ports);
    if (
      ports.size !== patch.ports.length ||
      patch.ports.length > MAX_WORKSPACE_PORTS ||
      patch.ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)
    ) {
      throw workspaceError(
        "invalid",
        "update ports",
        `Use at most ${MAX_WORKSPACE_PORTS} unique ports from 1 to 65535.`,
      );
    }
  }
  await sandbox.update({
    persistent: patch.persistent,
    resources: patch.vcpus === undefined ? undefined : { vcpus: patch.vcpus },
    timeout: patch.timeoutMs,
    ports: patch.ports,
    snapshotExpiration: patch.snapshotExpirationMs,
    keepLastSnapshots:
      patch.keepLastSnapshots === undefined
        ? undefined
        : patch.keepLastSnapshots === null
          ? null
          : {
              count: patch.keepLastSnapshots.count,
              expiration: patch.keepLastSnapshots.expirationMs,
              deleteEvicted: patch.keepLastSnapshots.deleteEvicted,
            },
    networkPolicy:
      patch.networkPolicy === undefined ? undefined : toNetworkPolicy(patch.networkPolicy),
  });
}

function sessionSummary(session: {
  id: string;
  status: WorkspaceSandboxStatus;
  region: string;
  runtime: string;
  vcpus: number;
  memory: number;
  timeout: number;
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
  duration?: number;
  activeCpuDurationMs?: number;
  networkTransfer?: { ingress: number; egress: number };
  sourceSnapshotId?: string;
}): WorkspaceSessionSummary {
  return {
    id: session.id,
    status: session.status,
    region: session.region,
    runtime: session.runtime,
    vcpus: session.vcpus,
    memoryMb: session.memory,
    timeoutMs: session.timeout,
    createdAt: iso(session.createdAt) ?? new Date(0).toISOString(),
    startedAt: iso(session.startedAt),
    stoppedAt: iso(session.stoppedAt),
    durationMs: session.duration ?? null,
    activeCpuDurationMs: session.activeCpuDurationMs ?? null,
    ingressBytes: session.networkTransfer?.ingress ?? null,
    egressBytes: session.networkTransfer?.egress ?? null,
    sourceSnapshotId: session.sourceSnapshotId ?? null,
  };
}

function snapshotSummary(
  snapshot: {
    id: string;
    status: "failed" | "created" | "deleted";
    sizeBytes: number;
    createdAt: number;
    updatedAt: number;
    expiresAt?: number;
    sourceSessionId: string;
    parentId?: string;
  },
  currentId: string | undefined,
): WorkspaceSnapshotSummary {
  return {
    id: snapshot.id,
    status: snapshot.status,
    sizeBytes: snapshot.sizeBytes,
    createdAt: iso(snapshot.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(snapshot.updatedAt) ?? new Date(0).toISOString(),
    expiresAt: iso(snapshot.expiresAt),
    sourceSessionId: snapshot.sourceSessionId,
    parentId: snapshot.parentId ?? null,
    current: snapshot.id === currentId,
  };
}

async function relatedTags(
  root: ListedSandbox,
  sessionId: string,
  kind: "fork" | "backup",
): Promise<Record<string, string>> {
  return {
    ruthKind: kind,
    ruthSession: sessionHash(sessionId),
    ruthRoot: root.name,
    ruthAgent: root.tags?.agent ?? "root",
  };
}

async function checkpointAndFork(
  source: Sandbox,
  root: ListedSandbox,
  sessionId: string,
  kind: "fork" | "backup",
  label?: string,
): Promise<Sandbox> {
  const wasRunning = ACTIVE_STATUSES.has(source.status);
  if (wasRunning) await source.snapshot();
  const name = `ruth-${sessionHash(sessionId).slice(0, 12)}-${kind}-${sanitizeLabel(label)}`.slice(
    0,
    96,
  );
  const fork = await Sandbox.fork({
    sourceSandbox: source.name,
    name,
    tags: await relatedTags(root, sessionId, kind),
    persistent: true,
  });
  if (wasRunning) await Sandbox.get({ name: source.name, resume: true });
  return fork;
}

async function lifecycle(
  target: WorkspaceTarget,
  action: WorkspaceLifecycleAction,
): Promise<void> {
  const resolved = await resolveLiveSandbox(target, false);
  const kind = kindFromTags(resolved.selected.tags, resolved.root.name, resolved.selected.name);
  if (action.type === "resume") {
    await Sandbox.get({ name: resolved.sandbox.name, resume: true });
    return;
  }
  if (action.type === "stop") {
    if (ACTIVE_STATUSES.has(resolved.sandbox.status)) await resolved.sandbox.stop();
    return;
  }
  if (action.confirmation !== resolved.sandbox.name) {
    throw workspaceError("invalid", "confirm the destructive action", "Type the sandbox name exactly.");
  }
  if (action.type === "delete-related") {
    if (kind !== "fork" && kind !== "backup") {
      throw workspaceError("invalid", "delete the sandbox", "The Eve root uses Reset instead.");
    }
    await resolved.sandbox.delete();
    return;
  }
  if (kind !== "root") {
    throw workspaceError("invalid", "reset the workspace", "Only the active Eve root can be reset.");
  }
  if (action.keepBackup) {
    await checkpointAndFork(
      resolved.sandbox,
      resolved.root,
      target.sessionId,
      "backup",
      "before-reset",
    );
  }
  await resolved.sandbox.delete();
}

async function snapshots(
  target: WorkspaceTarget,
  action: WorkspaceSnapshotAction,
): Promise<void> {
  const { sandbox } = await resolveLiveSandbox(target, false);
  if (action.type === "create") {
    await sandbox.snapshot({ expiration: action.expirationMs });
    return;
  }
  if (action.confirmation !== sandbox.name) {
    throw workspaceError("invalid", "confirm the snapshot action", "Type the sandbox name exactly.");
  }
  const snapshotPage = await sandbox.listSnapshots({
    limit: SANDBOX_LIST_PAGE_LIMIT,
    sortOrder: "desc",
  });
  let ownedSnapshot:
    | {
        id: string;
        status: "failed" | "created" | "deleted";
      }
    | undefined;
  // Keep the ownership decision sandbox-scoped while walking the complete
  // history. The provider page size is capped, so checking only the first
  // response would make valid older recovery points unreachable.
  for await (const page of snapshotPage.pages()) {
    ownedSnapshot = page.snapshots.find(
      (snapshot) =>
        snapshot.id === action.snapshotId &&
        snapshot.status !== "deleted",
    );
    if (ownedSnapshot !== undefined) break;
  }
  if (ownedSnapshot === undefined) {
    throw workspaceError(
      "not_found",
      "manage the snapshot",
      "That snapshot is not available for this workspace.",
    );
  }
  if (action.type === "delete") {
    if (sandbox.currentSnapshotId === action.snapshotId) {
      throw workspaceError("conflict", "delete the snapshot", "The current snapshot cannot be deleted.");
    }
    const snapshot = await Snapshot.get({ snapshotId: action.snapshotId });
    await snapshot.delete();
    return;
  }
  if (ACTIVE_STATUSES.has(sandbox.status)) await sandbox.snapshot();
  await sandbox.update({ currentSnapshotId: action.snapshotId });
  await Sandbox.get({ name: sandbox.name, resume: true });
}

async function forks(target: WorkspaceTarget, action: WorkspaceForkAction): Promise<void> {
  const resolved = await resolveLiveSandbox(target, false);
  if (action.type === "create") {
    await checkpointAndFork(
      resolved.sandbox,
      resolved.root,
      target.sessionId,
      "fork",
      action.label,
    );
    return;
  }
  const source = [...resolved.related, ...resolved.roots].find(
    (sandbox) => sandbox.name === action.sourceName,
  );
  if (source === undefined) {
    throw workspaceError("not_found", "manage the fork", "That related sandbox no longer exists.");
  }
  if (action.confirmation !== source.name) {
    throw workspaceError("invalid", "confirm the fork action", "Type the sandbox name exactly.");
  }
  const sourceLive = await Sandbox.get({ name: source.name, resume: false });
  if (action.type === "delete") {
    if (!RELATED_KINDS.has(source.tags?.ruthKind ?? "")) {
      throw workspaceError("invalid", "delete the fork", "Only a related fork or backup can be deleted.");
    }
    await sourceLive.delete();
    return;
  }
  if (!RELATED_KINDS.has(source.tags?.ruthKind ?? "")) {
    throw workspaceError("invalid", "promote the fork", "Only a related fork or backup can be promoted.");
  }
  const rootLive = await Sandbox.get({ name: resolved.root.name, resume: false });
  const rootWasRunning = ACTIVE_STATUSES.has(rootLive.status);
  const backup = await checkpointAndFork(
    rootLive,
    resolved.root,
    target.sessionId,
    "backup",
    "before-promote",
  );
  if (ACTIVE_STATUSES.has(sourceLive.status)) await sourceLive.snapshot();
  await rootLive.delete();
  try {
    await Sandbox.fork({
      sourceSandbox: sourceLive.name,
      name: resolved.root.name,
      tags: {
        agent: resolved.root.tags?.agent ?? source.tags?.ruthAgent ?? "root",
        channel: resolved.root.tags?.channel ?? "eve",
        sessionId: target.sessionId,
      },
      persistent: true,
    });
    if (rootWasRunning) await Sandbox.get({ name: resolved.root.name, resume: true });
  } catch (cause) {
    try {
      await Sandbox.fork({
        sourceSandbox: backup.name,
        name: resolved.root.name,
        tags: {
          agent: resolved.root.tags?.agent ?? "root",
          channel: resolved.root.tags?.channel ?? "eve",
          sessionId: target.sessionId,
        },
        persistent: true,
      });
    } catch {
      throw workspaceError(
        "provider",
        "promote the fork",
        `Promotion failed. Recovery backup ${backup.name} was preserved for retry.`,
      );
    }
    throw cause;
  }
}

async function overview(target: WorkspaceTarget, devTerminalUrl: string | null): Promise<WorkspaceOverview> {
  const resolved = await resolveSandboxes(target);
  if (resolved.root === null) {
    return {
      state: "not_started",
      root: null,
      target: null,
      generations: [],
      related: resolved.related.map((sandbox) => listedSummary(sandbox)),
      sessions: [],
      snapshots: [],
      devTerminalUrl,
      warning: "Anyone with access to this app can control a discoverable workspace.",
    };
  }
  if (resolved.selected === null) {
    throw workspaceError("not_found", "open the workspace", "The selected workspace was not found.");
  }
  const live = await Sandbox.get({ name: resolved.selected.name, resume: false });
  const [sessionPage, snapshotPage] = await Promise.all([
    live.listSessions({ limit: SANDBOX_LIST_PAGE_LIMIT, sortOrder: "desc" }),
    live.listSnapshots({ limit: SANDBOX_LIST_PAGE_LIMIT, sortOrder: "desc" }),
  ]);
  const [sessionItems, snapshotItems] = await Promise.all([
    sessionPage.toArray(),
    snapshotPage.toArray(),
  ]);
  const selectedKind = kindFromTags(
    resolved.selected.tags,
    resolved.root.name,
    resolved.selected.name,
  );
  const rootSummary = listedSummary(resolved.root, resolved.root.name);
  return {
    state: "ready",
    root: rootSummary,
    target: liveSummary(live, selectedKind),
    generations: resolved.roots
      .slice(1)
      .map((sandbox) => listedSummary(sandbox, resolved.root?.name)),
    related: resolved.related.map((sandbox) => listedSummary(sandbox, resolved.root?.name)),
    sessions: sessionItems.map((session) => sessionSummary(session)),
    snapshots: snapshotItems.map((snapshot) =>
      snapshotSummary(snapshot, live.currentSnapshotId),
    ),
    devTerminalUrl,
    warning: "Anyone with access to this app can control a discoverable workspace.",
  };
}

export class SandboxWorkspace extends Context.Service<
  SandboxWorkspace,
  {
    readonly overview: (
      target: WorkspaceTarget,
      devTerminalUrl?: string | null,
    ) => Effect.Effect<WorkspaceOverview, SandboxWorkspaceError>;
    readonly listDirectory: (
      target: WorkspaceTarget,
      path: string,
    ) => Effect.Effect<WorkspaceDirectory, SandboxWorkspaceError>;
    readonly readText: (
      target: WorkspaceTarget,
      path: string,
    ) => Effect.Effect<WorkspaceTextFile, SandboxWorkspaceError>;
    readonly writeText: (
      target: WorkspaceTarget,
      input: { path: string; content: string; expectedVersion?: string },
    ) => Effect.Effect<WorkspaceTextFile, SandboxWorkspaceError>;
    readonly mutateFs: (
      target: WorkspaceTarget,
      action: WorkspaceFsAction,
    ) => Effect.Effect<void, SandboxWorkspaceError>;
    readonly readFile: (
      target: WorkspaceTarget,
      path: string,
    ) => Effect.Effect<{ stream: NodeJS.ReadableStream; path: string; size: number }, SandboxWorkspaceError>;
    readonly processes: (
      target: WorkspaceTarget,
    ) => Effect.Effect<WorkspaceProcess[], SandboxWorkspaceError>;
    readonly signalProcess: (
      target: WorkspaceTarget,
      pid: number,
      signal: "TERM" | "KILL",
    ) => Effect.Effect<void, SandboxWorkspaceError>;
    readonly updateConfig: (
      target: WorkspaceTarget,
      patch: WorkspaceConfigPatch,
    ) => Effect.Effect<void, SandboxWorkspaceError>;
    readonly lifecycle: (
      target: WorkspaceTarget,
      action: WorkspaceLifecycleAction,
    ) => Effect.Effect<void, SandboxWorkspaceError>;
    readonly snapshots: (
      target: WorkspaceTarget,
      action: WorkspaceSnapshotAction,
    ) => Effect.Effect<void, SandboxWorkspaceError>;
    readonly forks: (
      target: WorkspaceTarget,
      action: WorkspaceForkAction,
    ) => Effect.Effect<void, SandboxWorkspaceError>;
    readonly openInteractive: (
      target: WorkspaceTarget,
    ) => Effect.Effect<{ url: string; token: string }, SandboxWorkspaceError>;
    readonly openUpload: (
      target: WorkspaceTarget,
      input: { path: string; size: number; overwrite: boolean },
    ) => Effect.Effect<WorkspaceUploadHandle, SandboxWorkspaceError>;
  }
>()("SandboxWorkspace") {}

export const SandboxWorkspaceLive = Layer.succeed(SandboxWorkspace, {
  overview: (target, devTerminalUrl = null) =>
    providerEffect("load the workspace", () => overview(target, devTerminalUrl)),
  listDirectory: (target, path) =>
    providerEffect("list the directory", async () => {
      const { sandbox } = await resolveLiveSandbox(target, true);
      return directory(sandbox, path);
    }),
  readText: (target, path) =>
    providerEffect("read the file", async () => {
      const { sandbox } = await resolveLiveSandbox(target, true);
      return readText(sandbox, path);
    }),
  writeText: (target, input) =>
    providerEffect("save the file", async () => {
      const { sandbox } = await resolveLiveSandbox(target, true);
      return writeText(sandbox, input);
    }),
  mutateFs: (target, action) =>
    providerEffect("change the filesystem", async () => {
      const { sandbox } = await resolveLiveSandbox(target, true);
      await mutateFs(sandbox, action);
    }),
  readFile: (target, path) =>
    providerEffect("download the file", async () => {
      const { sandbox } = await resolveLiveSandbox(target, true);
      const normalized = await assertInWorkspace(sandbox, path);
      const stats = await sandbox.fs.stat(normalized);
      if (!stats.isFile()) {
        throw workspaceError("invalid", "download the file", "Only regular files can be downloaded.");
      }
      const stream = await sandbox.readFile({ path: normalized });
      if (stream === null) {
        throw workspaceError("not_found", "download the file", "The file no longer exists.");
      }
      return { stream, path: normalized, size: stats.size };
    }),
  processes: (target) =>
    providerEffect("list processes", async () => {
      const { sandbox } = await resolveLiveSandbox(target, true);
      return processList(sandbox);
    }),
  signalProcess: (target, pid, signal) =>
    providerEffect("signal the process", async () => {
      const { sandbox } = await resolveLiveSandbox(target, true);
      await signalProcess(sandbox, pid, signal);
    }),
  updateConfig: (target, patch) =>
    providerEffect("update configuration", async () => {
      const { sandbox } = await resolveLiveSandbox(target, false);
      await updateConfig(sandbox, patch);
    }),
  lifecycle: (target, action) =>
    providerEffect("change lifecycle state", () => lifecycle(target, action)),
  snapshots: (target, action) =>
    providerEffect("manage snapshots", () => snapshots(target, action)),
  forks: (target, action) => providerEffect("manage forks", () => forks(target, action)),
  openInteractive: (target) =>
    providerEffect("open a terminal", async () => {
      const { sandbox } = await resolveLiveSandbox(target, true);
      return sandbox.openInteractive();
    }),
  openUpload: (target, input) =>
    providerEffect("start the upload", () => openUpload(target, input)),
});

export const workspaceOverview = (target: WorkspaceTarget, devTerminalUrl?: string | null) =>
  Effect.flatMap(SandboxWorkspace, (service) => service.overview(target, devTerminalUrl));

export const listWorkspaceDirectory = (target: WorkspaceTarget, path: string) =>
  Effect.flatMap(SandboxWorkspace, (service) => service.listDirectory(target, path));

export const readWorkspaceText = (target: WorkspaceTarget, path: string) =>
  Effect.flatMap(SandboxWorkspace, (service) => service.readText(target, path));

export const writeWorkspaceText = (
  target: WorkspaceTarget,
  input: { path: string; content: string; expectedVersion?: string },
) => Effect.flatMap(SandboxWorkspace, (service) => service.writeText(target, input));

export const mutateWorkspaceFs = (target: WorkspaceTarget, action: WorkspaceFsAction) =>
  Effect.flatMap(SandboxWorkspace, (service) => service.mutateFs(target, action));

export const readWorkspaceFile = (target: WorkspaceTarget, path: string) =>
  Effect.flatMap(SandboxWorkspace, (service) => service.readFile(target, path));

export const listWorkspaceProcesses = (target: WorkspaceTarget) =>
  Effect.flatMap(SandboxWorkspace, (service) => service.processes(target));

export const signalWorkspaceProcess = (
  target: WorkspaceTarget,
  pid: number,
  signal: "TERM" | "KILL",
) => Effect.flatMap(SandboxWorkspace, (service) => service.signalProcess(target, pid, signal));

export const updateWorkspaceConfig = (target: WorkspaceTarget, patch: WorkspaceConfigPatch) =>
  Effect.flatMap(SandboxWorkspace, (service) => service.updateConfig(target, patch));

export const changeWorkspaceLifecycle = (
  target: WorkspaceTarget,
  action: WorkspaceLifecycleAction,
) => Effect.flatMap(SandboxWorkspace, (service) => service.lifecycle(target, action));

export const manageWorkspaceSnapshots = (
  target: WorkspaceTarget,
  action: WorkspaceSnapshotAction,
) => Effect.flatMap(SandboxWorkspace, (service) => service.snapshots(target, action));

export const manageWorkspaceForks = (target: WorkspaceTarget, action: WorkspaceForkAction) =>
  Effect.flatMap(SandboxWorkspace, (service) => service.forks(target, action));

export const openWorkspaceInteractive = (target: WorkspaceTarget) =>
  Effect.flatMap(SandboxWorkspace, (service) => service.openInteractive(target));

export const openWorkspaceUpload = (
  target: WorkspaceTarget,
  input: { path: string; size: number; overwrite: boolean },
) => Effect.flatMap(SandboxWorkspace, (service) => service.openUpload(target, input));

export const invalidWorkspaceRequest = (operation: string, message: string) =>
  invalid(operation, message);
