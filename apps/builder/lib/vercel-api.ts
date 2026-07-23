import type { DeployFile } from "./assemble";

// Minimal typed client for the slice of the Vercel REST API the deploy
// pipeline uses. Every call authenticates with the user's token, scoped to
// the team they chose. Errors carry the failing stage so the wizard can
// point at the right step.

const API = "https://api.vercel.com";

export type DeployStage = "token" | "project" | "storage" | "env" | "deploy" | "build";

export class VercelApiError extends Error {
  constructor(
    public stage: DeployStage,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "VercelApiError";
  }
}

interface RequestOptions {
  token: string;
  teamId?: string | null;
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  stage: DeployStage;
}

async function api<T>(pathname: string, options: RequestOptions): Promise<T> {
  const url = new URL(API + pathname);
  if (options.teamId != null && options.teamId.length > 0) {
    url.searchParams.set("teamId", options.teamId);
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload !== null &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error !== null &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : `Vercel API ${response.status}`;
    throw new VercelApiError(options.stage, message, response.status);
  }
  return payload as T;
}

export interface VercelIdentity {
  user: { id: string; username: string; email?: string };
  teams: { id: string; slug: string; name: string }[];
}

/** Validates the token and lists the scopes it can deploy into. */
export async function identify(token: string): Promise<VercelIdentity> {
  const [userBody, teamsBody] = await Promise.all([
    api<{ user: { id: string; username: string; email?: string } }>("/v2/user", {
      token,
      stage: "token",
    }),
    api<{ teams: { id: string; slug: string; name: string }[] }>("/v2/teams?limit=100", {
      token,
      stage: "token",
    }),
  ]);
  return { user: userBody.user, teams: teamsBody.teams ?? [] };
}

export interface CreatedProject {
  id: string;
  name: string;
  /** True when the project already existed and we're deploying into it. */
  existed: boolean;
}

export async function createProject(
  token: string,
  teamId: string | null,
  name: string,
): Promise<CreatedProject> {
  try {
    const project = await api<{ id: string; name: string }>("/v11/projects", {
      token,
      teamId,
      method: "POST",
      body: { name, framework: "nextjs" },
      stage: "project",
    });
    return { id: project.id, name: project.name, existed: false };
  } catch (error) {
    // 409: the project exists. Deploy into it (documented redeploy path).
    if (error instanceof VercelApiError && error.status === 409) {
      const existing = await api<{ id: string; name: string }>(
        `/v9/projects/${encodeURIComponent(name)}`,
        { token, teamId, stage: "project" },
      );
      return { id: existing.id, name: existing.name, existed: true };
    }
    throw error;
  }
}

export interface StorageStore {
  id: string;
  name: string;
  /** "blob" for Blob stores; integration resources (Neon etc.) report their product. */
  kind: "blob" | "integration";
  productName: string | null;
}

/**
 * Existing storage resources on the account: Blob stores plus Marketplace
 * databases (Neon, Supabase, …). Connecting one to a project makes Vercel
 * inject its env vars (DATABASE_URL, BLOB_READ_WRITE_TOKEN) directly.
 */
export async function listStores(token: string, teamId: string | null): Promise<StorageStore[]> {
  const body = await api<{
    stores?: {
      id: string;
      name: string;
      type?: string | null;
      product?: { name?: string; slug?: string } | null;
    }[];
  }>("/v1/storage/stores", { token, teamId, stage: "storage" });
  return (body.stores ?? []).map((store) => ({
    id: store.id,
    name: store.name,
    kind: store.type === "blob" || store.type == null ? "blob" : "integration",
    productName: store.product?.name ?? store.product?.slug ?? null,
  }));
}

/** Creates a Blob store and returns its id. */
export async function createBlobStore(
  token: string,
  teamId: string | null,
  name: string,
): Promise<string> {
  const body = await api<{ store: { id: string } }>("/v1/storage/stores/blob", {
    token,
    teamId,
    method: "POST",
    body: { name, region: "iad1", access: "public" },
    stage: "storage",
  });
  return body.store.id;
}

/**
 * Provisions a fresh Neon Postgres database through the Vercel Marketplace
 * auto-provision API (server-default billing plan, i.e. the free tier) and
 * returns the new resource's store id. Works headlessly when the account
 * already has the Neon integration installed; otherwise Vercel requires a
 * one-time terms acceptance in the browser, which we surface as an error
 * with the fallback options.
 */
export async function provisionNeonDatabase(
  token: string,
  teamId: string | null,
  name: string,
): Promise<string> {
  const integration = await api<{
    id: string;
    slug: string;
    products?: { id: string; slug: string }[];
  }>("/v2/integrations/integration/neon", { token, teamId, stage: "storage" });
  const product = integration.products?.[0];
  if (product === undefined) {
    throw new VercelApiError("storage", "The Neon integration exposes no products");
  }

  const installations = await api<{ id: string }[]>(
    `/v2/integrations/configurations?view=account&installationType=marketplace&integrationIdOrSlug=${integration.id}`,
    { token, teamId, stage: "storage" },
  );
  if (!Array.isArray(installations) || installations.length === 0) {
    throw new VercelApiError(
      "storage",
      "Your Vercel account hasn't installed the Neon integration yet. Install it once (vercel.com → Storage → Create Database → Neon), then retry — or pick an existing database / paste a connection string.",
    );
  }

  const result = await api<{
    kind?: string;
    reason?: string;
    resource?: { id: string };
  }>(
    `/v1/integrations/integration/${integration.slug}/marketplace/auto-provision/${product.slug}`,
    {
      token,
      teamId,
      method: "POST",
      body: {
        name,
        metadata: {},
        acceptedPolicies: {},
        source: "cli",
        ...(installations.length === 1 ? { installationId: installations[0].id } : {}),
      },
      stage: "storage",
    },
  );
  if (result.kind !== "provisioned" || result.resource === undefined) {
    throw new VercelApiError(
      "storage",
      `Vercel couldn't create the database automatically (${result.reason ?? result.kind ?? "unknown"}). Pick an existing database or paste a connection string instead.`,
    );
  }
  return result.resource.id;
}

/** Connects a store to a project; Vercel injects the store's env vars. */
export async function connectStoreToProject(
  token: string,
  teamId: string | null,
  storeId: string,
  projectId: string,
): Promise<void> {
  await api(`/v1/storage/stores/${storeId}/connections`, {
    token,
    teamId,
    method: "POST",
    body: {
      projectId,
      type: "integration",
      envVarEnvironments: ["production", "preview", "development"],
    },
    stage: "storage",
  });
}

/** Env var keys currently present on a project (values not fetched). */
export async function listProjectEnvKeys(
  token: string,
  teamId: string | null,
  projectId: string,
): Promise<string[]> {
  const body = await api<{ envs?: { key: string }[] }>(`/v10/projects/${projectId}/env`, {
    token,
    teamId,
    stage: "storage",
  });
  return (body.envs ?? []).map((entry) => entry.key);
}

export interface EnvVar {
  key: string;
  value: string;
}

export async function upsertEnv(
  token: string,
  teamId: string | null,
  projectId: string,
  vars: EnvVar[],
): Promise<void> {
  await api(`/v10/projects/${projectId}/env?upsert=true`, {
    token,
    teamId,
    method: "POST",
    body: vars.map((entry) => ({
      key: entry.key,
      value: entry.value,
      type: "encrypted",
      target: ["production", "preview", "development"],
    })),
    stage: "env",
  });
}

export interface CreatedDeployment {
  id: string;
  url: string;
  inspectorUrl: string | null;
  readyState: string;
}

export async function createDeployment(
  token: string,
  teamId: string | null,
  projectName: string,
  files: DeployFile[],
): Promise<CreatedDeployment> {
  const deployment = await api<{
    id: string;
    url: string;
    inspectorUrl?: string;
    readyState?: string;
    status?: string;
  }>("/v13/deployments?skipAutoDetectionConfirmation=1", {
    token,
    teamId,
    method: "POST",
    body: {
      name: projectName,
      project: projectName,
      target: "production",
      files,
      projectSettings: { framework: "nextjs" },
    },
    stage: "deploy",
  });
  return {
    id: deployment.id,
    url: deployment.url,
    inspectorUrl: deployment.inspectorUrl ?? null,
    readyState: deployment.readyState ?? deployment.status ?? "QUEUED",
  };
}

export interface DeploymentStatus {
  readyState: string;
  url: string;
  /** Present when the build failed: the tail of the build log. */
  errorLog: string | null;
}

export async function getDeploymentStatus(
  token: string,
  teamId: string | null,
  deploymentId: string,
): Promise<DeploymentStatus> {
  const deployment = await api<{ readyState?: string; status?: string; url: string }>(
    `/v13/deployments/${deploymentId}`,
    { token, teamId, stage: "build" },
  );
  const readyState = deployment.readyState ?? deployment.status ?? "QUEUED";

  let errorLog: string | null = null;
  if (readyState === "ERROR") {
    try {
      const events = await api<{ type: string; payload?: { text?: string } }[]>(
        `/v3/deployments/${deploymentId}/events?builds=1&limit=200`,
        { token, teamId, stage: "build" },
      );
      const lines = events
        .map((event) => event.payload?.text ?? "")
        .filter((text) => text.length > 0);
      errorLog = lines.slice(-40).join("\n") || null;
    } catch {
      errorLog = null;
    }
  }

  return { readyState, url: deployment.url, errorLog };
}
