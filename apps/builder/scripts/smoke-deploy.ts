import { assembleDeployment } from "../lib/assemble";
import type { AgentConfig } from "../lib/config";
import { createDeployment, createProject, getDeploymentStatus, identify, upsertEnv } from "../lib/vercel-api";

// Manual end-to-end check of the deploy pipeline against a real Vercel
// account. Creates a throwaway project, deploys a minimal agent, waits for
// READY, hits the health route, then deletes the project.
//
//   VERCEL_TOKEN=… DATABASE_URL=… npx tsx scripts/smoke-deploy.ts [teamId]
//
// Uses real build minutes on the target account; run before releases, not in CI.

const token = process.env.VERCEL_TOKEN;
const databaseUrl = process.env.DATABASE_URL;
if (!token || !databaseUrl) {
  console.error("Set VERCEL_TOKEN and DATABASE_URL first.");
  process.exit(1);
}
const teamId = process.argv[2] ?? null;

const projectName = `eveclaw-smoke-${Date.now().toString(36)}`;
const config: AgentConfig = {
  agentName: "Smoke",
  projectName,
  ownerName: "Smoke Tester",
  model: "anthropic/claude-haiku-4-5",
  features: ["utilities"],
  instructions: "# Identity\nYou are Smoke, a test agent. Reply tersely.",
  telegram: null,
  schedules: [],
  postgres: { mode: "manual", url: databaseUrl },
  blob: { mode: "manual", token: "" },
  keys: {},
};

const identity = await identify(token);
console.log(`token ok: ${identity.user.username}${teamId !== null ? ` (team ${teamId})` : ""}`);

const project = await createProject(token, teamId, projectName);
console.log(`project created: ${project.name} (${project.id})`);

try {
  await upsertEnv(token, teamId, project.id, [
    { key: "DATABASE_URL", value: databaseUrl },
    { key: "OWNER_NAME", value: "Smoke Tester" },
    { key: "EVE_ENABLED_FEATURES", value: "utilities" },
  ]);
  console.log("env vars set");

  const files = await assembleDeployment(config);
  console.log(`assembled ${files.length} files`);

  const deployment = await createDeployment(token, teamId, project.name, files);
  console.log(`deployment ${deployment.id} created; building…`);

  const startedAt = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const status = await getDeploymentStatus(token, teamId, deployment.id);
    process.stdout.write(`  ${status.readyState} (${Math.round((Date.now() - startedAt) / 1000)}s)\n`);
    if (status.readyState === "READY") {
      const health = await fetch(`https://${status.url}/eve/v1/health`);
      console.log(`health: ${health.status}`);
      break;
    }
    if (status.readyState === "ERROR" || status.readyState === "CANCELED") {
      console.error("build failed:\n" + (status.errorLog ?? "(no log)"));
      process.exitCode = 1;
      break;
    }
    if (Date.now() - startedAt > 12 * 60 * 1000) {
      console.error("timed out waiting for the build");
      process.exitCode = 1;
      break;
    }
  }
} finally {
  const cleanup = await fetch(
    `https://api.vercel.com/v9/projects/${project.id}${teamId !== null ? `?teamId=${teamId}` : ""}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  console.log(`project deleted: ${cleanup.status === 204 ? "ok" : `status ${cleanup.status}`}`);
}
