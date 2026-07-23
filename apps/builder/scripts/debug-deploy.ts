import { assembleDeployment } from "../lib/assemble";
import type { AgentConfig } from "../lib/config";
import { createDeployment, getDeploymentStatus } from "../lib/vercel-api";

// One-off diagnostic deploy to an existing project: same template plus a
// debug route that reports what the runtime sees (OIDC claims, env presence)
// and replays the failing workflow call. Usage:
//   VERCEL_TOKEN=… npx tsx scripts/debug-deploy.ts <project> [teamId]

const token = process.env.VERCEL_TOKEN;
if (!token) throw new Error("Set VERCEL_TOKEN");
const projectName = process.argv[2] ?? "eve";
const teamId = process.argv[3] ?? null;

const DEBUG_ROUTE = `import { getVercelOidcToken } from "@vercel/oidc";

export async function GET(): Promise<Response> {
  const report: Record<string, unknown> = {
    env: {
      VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID ?? null,
      VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID ?? null,
      VERCEL_ENV: process.env.VERCEL_ENV ?? null,
      has_VERCEL_OIDC_TOKEN: Boolean(process.env.VERCEL_OIDC_TOKEN),
      workflowVars: Object.keys(process.env).filter((k) => k.includes("WORKFLOW")),
    },
  };
  try {
    const oidc = await getVercelOidcToken();
    const payload = JSON.parse(Buffer.from(oidc.split(".")[1], "base64url").toString());
    report.oidcClaims = payload;
    const dep = process.env.VERCEL_DEPLOYMENT_ID ?? "";
    const res = await fetch(
      \`https://api.vercel.com/v1/workflow/resolve-latest-deployment/\${encodeURIComponent(dep)}\`,
      { headers: { Authorization: \`Bearer \${oidc}\` } },
    );
    report.resolveCall = { status: res.status, body: (await res.text()).slice(0, 300) };
  } catch (error) {
    report.oidcError = error instanceof Error ? error.message : String(error);
  }
  return Response.json(report);
}
`;

const config: AgentConfig = {
  agentName: "Debug",
  projectName,
  ownerName: "Debug",
  model: "anthropic/claude-haiku-4-5",
  features: ["utilities"],
  instructions: "# Debug",
  telegram: null,
  schedules: [],
  postgres: { mode: "manual", url: "postgresql://unused" },
  blob: { mode: "manual", token: "" },
  keys: {},
};

const files = await assembleDeployment(config);
// Restore the real instructions (this is a debug overlay, not a reconfigure):
// drop our stub instructions.md so the deployed one isn't clobbered — actually
// keep template default; the agent isn't the point of this deployment.
files.push({
  file: "app/api/debug-workflow/route.ts",
  data: Buffer.from(DEBUG_ROUTE, "utf8").toString("base64"),
  encoding: "base64",
});

const deployment = await createDeployment(token, teamId, projectName, files);
console.log("deployment:", deployment.id, deployment.url);
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const status = await getDeploymentStatus(token, teamId, deployment.id);
  console.log(" ", status.readyState);
  if (status.readyState === "READY") break;
  if (status.readyState === "ERROR") {
    console.error(status.errorLog ?? "(no log)");
    process.exit(1);
  }
}
console.log(`probe: https://${deployment.url}/api/debug-workflow`);
