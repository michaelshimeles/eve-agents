import webpush from "web-push";

import { assembleDeployment, templateFiles } from "@/lib/assemble";
import { requiredKeys, validateConfig, type AgentConfig, type DeployTarget } from "@/lib/config";
import { validCron } from "@/lib/schedule-codegen";
import {
  connectStoreToProject,
  createBlobStore,
  createDeployment,
  createProject,
  listProjectEnvKeys,
  upsertEnv,
  VercelApiError,
  type EnvVar,
} from "@/lib/vercel-api";

// The deploy pipeline: project → storage connections → env vars →
// deployment, all against the user's Vercel account with their token.
// Secrets exist only inside this request; the builder stores nothing.
// `dryRun` returns the assembled file list and env keys for the review step
// without touching any account.

export const maxDuration = 120;

interface DeployRequest {
  target?: DeployTarget;
  config?: AgentConfig;
  dryRun?: boolean;
}

function buildEnv(config: AgentConfig): EnvVar[] {
  const vapid = webpush.generateVAPIDKeys();
  const vars: EnvVar[] = [
    { key: "OWNER_NAME", value: config.ownerName.trim() },
    { key: "EVE_ENABLED_FEATURES", value: config.features.join(",") },
    { key: "NEXT_PUBLIC_VAPID_PUBLIC_KEY", value: vapid.publicKey },
    { key: "VAPID_PRIVATE_KEY", value: vapid.privateKey },
  ];
  // Connected stores inject DATABASE_URL / BLOB_READ_WRITE_TOKEN themselves.
  if (config.postgres.mode === "manual") {
    vars.push({ key: "DATABASE_URL", value: config.postgres.url.trim() });
  }
  if (requiredKeys(config.features).blob && config.blob.mode === "manual") {
    vars.push({ key: "BLOB_READ_WRITE_TOKEN", value: config.blob.token.trim() });
  }
  if (config.keys.supermemoryApiKey?.trim()) {
    vars.push({ key: "SUPERMEMORY_API_KEY", value: config.keys.supermemoryApiKey.trim() });
  }
  if (config.keys.composioApiKey?.trim()) {
    vars.push({ key: "COMPOSIO_API_KEY", value: config.keys.composioApiKey.trim() });
  }
  if (config.telegram !== null) {
    vars.push({ key: "TELEGRAM_BOT_TOKEN", value: config.telegram.botToken.trim() });
    vars.push({ key: "TELEGRAM_WEBHOOK_SECRET_TOKEN", value: config.telegram.webhookSecret });
    if (config.telegram.botUsername.trim().length > 0) {
      vars.push({ key: "TELEGRAM_BOT_USERNAME", value: config.telegram.botUsername.trim() });
    }
    if (config.telegram.allowedUserIds.trim().length > 0) {
      vars.push({ key: "TELEGRAM_ALLOWED_USER_IDS", value: config.telegram.allowedUserIds.trim() });
    }
  }
  return vars;
}

/**
 * Connects the selected stores to the project and verifies Vercel injected
 * the env vars the agent needs — the safety net for picking a database whose
 * integration doesn't provide DATABASE_URL.
 */
async function connectStorage(
  token: string,
  teamId: string | null,
  projectId: string,
  projectName: string,
  config: AgentConfig,
): Promise<void> {
  const wantBlob = requiredKeys(config.features).blob;

  if (config.postgres.mode === "connect") {
    await connectStoreToProject(token, teamId, config.postgres.storeId, projectId);
  }
  if (wantBlob && config.blob.mode !== "manual") {
    const storeId =
      config.blob.mode === "create"
        ? await createBlobStore(token, teamId, `${projectName}-blob`)
        : config.blob.storeId;
    await connectStoreToProject(token, teamId, storeId, projectId);
  }

  const expected: string[] = [];
  if (config.postgres.mode === "connect") expected.push("DATABASE_URL");
  if (wantBlob && config.blob.mode !== "manual") expected.push("BLOB_READ_WRITE_TOKEN");
  if (expected.length === 0) return;

  const keys = await listProjectEnvKeys(token, teamId, projectId);
  for (const key of expected) {
    if (!keys.includes(key)) {
      throw new VercelApiError(
        "storage",
        key === "DATABASE_URL"
          ? "The connected database didn't provide DATABASE_URL. Pick a Neon database, or paste a connection string instead."
          : "The connected Blob store didn't provide BLOB_READ_WRITE_TOKEN. Paste a token instead.",
      );
    }
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as DeployRequest | null;
  if (body === null || body.config === undefined) {
    return Response.json({ error: "Missing config" }, { status: 400 });
  }
  const config = body.config;

  const problem = validateConfig(config);
  if (problem !== null) return Response.json({ error: problem }, { status: 400 });
  for (const schedule of config.schedules) {
    if (!validCron(schedule.cron)) {
      return Response.json(
        { error: `Invalid cron expression: ${schedule.cron}` },
        { status: 400 },
      );
    }
  }

  if (body.dryRun === true) {
    const files = await templateFiles(config);
    const envKeys = buildEnv(config).map((entry) => entry.key);
    if (config.postgres.mode === "connect") envKeys.push("DATABASE_URL (from connected database)");
    if (requiredKeys(config.features).blob && config.blob.mode !== "manual") {
      envKeys.push("BLOB_READ_WRITE_TOKEN (from Blob store)");
    }
    const scheduleFiles = config.schedules.map((_, index) => `agent/schedules/custom-*.ts (#${index + 1})`);
    return Response.json({ files: [...files, ...scheduleFiles], envKeys });
  }

  const target = body.target;
  if (target === undefined || typeof target.token !== "string" || target.token.trim().length === 0) {
    return Response.json({ error: "Missing Vercel token" }, { status: 400 });
  }
  const token = target.token.trim();
  const teamId = target.teamId ?? null;

  try {
    const project = await createProject(token, teamId, config.projectName);
    await connectStorage(token, teamId, project.id, project.name, config);
    await upsertEnv(token, teamId, project.id, buildEnv(config));
    const files = await assembleDeployment(config);
    const deployment = await createDeployment(token, teamId, project.name, files);
    return Response.json({
      projectId: project.id,
      projectName: project.name,
      projectExisted: project.existed,
      deploymentId: deployment.id,
      url: deployment.url,
      inspectorUrl: deployment.inspectorUrl,
      readyState: deployment.readyState,
    });
  } catch (error) {
    if (error instanceof VercelApiError) {
      console.error(`deploy failed at ${error.stage}:`, error.message);
      return Response.json({ error: error.message, stage: error.stage }, { status: 502 });
    }
    console.error("deploy failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Deploy failed", stage: "deploy" },
      { status: 500 },
    );
  }
}
