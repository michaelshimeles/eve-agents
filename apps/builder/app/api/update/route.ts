import {
  assembleDeployment,
  BUILDER_MANIFEST_FILE,
  templateInfo,
  type BuilderManifest,
  type DeployFile,
} from "@/lib/assemble";
import { FEATURE_IDS, type FeatureId } from "@/lib/config";
import { FEATURE_FILES } from "@/lib/manifest";
import {
  createDeployment,
  getDeploymentFile,
  getProject,
  latestProductionDeploymentId,
  listDeploymentFiles,
  listProjectEnvKeys,
  listProjects,
  upsertEnv,
  VercelApiError,
} from "@/lib/vercel-api";

// The update pipeline: bring an agent deployed by this builder onto the
// current template without re-entering any configuration. Everything needed
// is read back from the agent's own production deployment — eve-builder.json
// (features + version), agent/instructions.md (possibly hand-edited), and
// generated custom schedule files — then reassembled against the latest
// template and deployed into the same project. Env vars are left untouched
// except the version stamps, so keys, VAPID pair, and storage connections
// all survive. Works with just a Vercel token; the builder stores nothing.
//
// Provenance: git-linked projects are rejected (builder deploys never link
// a repo). Updates require eve-builder.json, or — for agents that predate
// the manifest — the builder-stamped EVE_ENABLED_FEATURES env key.

export const maxDuration = 120;

interface UpdateRequest {
  token?: unknown;
  teamId?: unknown;
  action?: unknown; // "projects" | "inspect" | "update"
  projectName?: unknown;
}

/** Exact path match, else any depth-tolerant suffix match. */
function findPath(files: Map<string, string>, relative: string): string | null {
  if (files.has(relative)) return relative;
  const suffix = `/${relative}`;
  for (const key of files.keys()) {
    if (key.endsWith(suffix)) return key;
  }
  return null;
}

interface DeployedAgent {
  projectId: string;
  projectName: string;
  deploymentId: string;
  files: Map<string, string>;
  /** Null for deployments that predate versioning. */
  currentVersion: string | null;
  features: FeatureId[];
  instructionsPath: string;
  customSchedulePaths: string[];
}

class InspectError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function readDeployedAgent(
  token: string,
  teamId: string | null,
  projectName: string,
): Promise<DeployedAgent> {
  const project = await getProject(token, teamId, projectName);
  if (project === null) {
    throw new InspectError(`No project named "${projectName}" in this Vercel scope.`, 404);
  }
  // Builder deploys never attach a git repo; a linked repo is almost always
  // a git-deployed Eve (or something else) and must not be overwritten.
  if (project.hasGitRepository) {
    throw new InspectError(
      `"${projectName}" is linked to a git repository, so it wasn't deployed by this builder and can't be updated here.`,
      409,
    );
  }

  const deploymentId = await latestProductionDeploymentId(token, teamId, project.id);
  if (deploymentId === null) {
    throw new InspectError(
      "That project has no successful production deployment to update.",
      409,
    );
  }

  let files: Map<string, string>;
  try {
    files = await listDeploymentFiles(token, teamId, deploymentId);
  } catch (error) {
    if (error instanceof VercelApiError && error.status === 404) {
      throw new InspectError(
        `"${projectName}" wasn't deployed by this builder (its deployment has no readable source files), so it can't be updated here.`,
        409,
      );
    }
    throw error;
  }

  const instructionsPath = findPath(files, "agent/instructions.md");
  if (instructionsPath === null || findPath(files, "agent/agent.ts") === null) {
    throw new InspectError(
      `"${projectName}" doesn't look like an agent deployed by this builder.`,
      409,
    );
  }

  // Prefer the baked manifest (definitive builder provenance). Without it,
  // only accept agents that still carry the builder-stamped feature env key —
  // path checks alone aren't enough, since a git-exported Eve tree can look
  // identical.
  let currentVersion: string | null = null;
  let features: FeatureId[] | null = null;
  const manifestPath = findPath(files, BUILDER_MANIFEST_FILE);
  if (manifestPath !== null) {
    try {
      const raw = await getDeploymentFile(token, teamId, deploymentId, files.get(manifestPath)!);
      const parsed = JSON.parse(raw.toString("utf8")) as Partial<BuilderManifest>;
      if (typeof parsed.templateVersion === "string" && parsed.templateVersion.length > 0) {
        currentVersion = parsed.templateVersion;
      }
      if (Array.isArray(parsed.features)) {
        features = parsed.features.filter((feature): feature is FeatureId =>
          FEATURE_IDS.includes(feature as FeatureId),
        );
      }
    } catch {
      // Unreadable manifest — fall through to the legacy env-key check.
    }
  }
  if (features === null) {
    const envKeys = await listProjectEnvKeys(token, teamId, project.id);
    if (!envKeys.includes("EVE_ENABLED_FEATURES")) {
      throw new InspectError(
        `"${projectName}" wasn't deployed by this builder (no eve-builder.json manifest or builder env stamps), so it can't be updated here.`,
        409,
      );
    }
    features = FEATURE_IDS.filter((feature) =>
      FEATURE_FILES[feature].some((file) => findPath(files, file) !== null),
    );
  }

  const customSchedulePaths = [...files.keys()].filter((key) =>
    key.includes("agent/schedules/custom-"),
  );

  return {
    projectId: project.id,
    projectName: project.name,
    deploymentId,
    files,
    currentVersion,
    features,
    instructionsPath,
    customSchedulePaths,
  };
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as UpdateRequest | null;
  if (body === null || typeof body.token !== "string" || body.token.trim().length === 0) {
    return Response.json({ error: "Missing Vercel token" }, { status: 400 });
  }
  const token = body.token.trim();
  const teamId = typeof body.teamId === "string" && body.teamId.length > 0 ? body.teamId : null;
  const action = body.action;

  try {
    const latest = await templateInfo();

    if (action === "projects") {
      const projects = await listProjects(token, teamId);
      return Response.json({ projects, latestVersion: latest.version });
    }

    if (typeof body.projectName !== "string" || body.projectName.trim().length === 0) {
      return Response.json({ error: "Missing project name" }, { status: 400 });
    }
    const agent = await readDeployedAgent(token, teamId, body.projectName.trim());

    if (action === "inspect") {
      return Response.json({
        projectName: agent.projectName,
        currentVersion: agent.currentVersion,
        latestVersion: latest.version,
        upToDate: agent.currentVersion === latest.version,
        features: agent.features,
        customScheduleCount: agent.customSchedulePaths.length,
      });
    }

    if (action !== "update") {
      return Response.json({ error: "Unknown action" }, { status: 400 });
    }

    const instructionsBuffer = await getDeploymentFile(
      token,
      teamId,
      agent.deploymentId,
      agent.files.get(agent.instructionsPath)!,
    );
    const instructions = instructionsBuffer.toString("utf8");
    if (instructions.trim().length === 0) {
      throw new InspectError("The deployed agent has empty instructions; update aborted.", 409);
    }

    // Custom schedule files were generated per-config at original deploy
    // time; carry them forward verbatim so recurring jobs survive.
    const carried: DeployFile[] = [];
    for (const sourcePath of agent.customSchedulePaths) {
      const contents = await getDeploymentFile(
        token,
        teamId,
        agent.deploymentId,
        agent.files.get(sourcePath)!,
      );
      const target = sourcePath.slice(sourcePath.indexOf("agent/schedules/"));
      carried.push({ file: target, data: contents.toString("base64"), encoding: "base64" });
    }

    const files = await assembleDeployment({
      projectName: agent.projectName,
      features: agent.features,
      instructions,
      schedules: [],
    });
    files.push(...carried);

    // Only the stamps change; every other env var (keys, VAPID pair,
    // storage-injected values) stays exactly as it is.
    await upsertEnv(token, teamId, agent.projectId, [
      { key: "EVE_TEMPLATE_VERSION", value: latest.version },
      { key: "EVE_TEMPLATE_PUBLISHED_AT", value: latest.publishedAt },
      { key: "EVE_PROJECT_NAME", value: agent.projectName },
      { key: "EVE_BUILDER_URL", value: new URL(request.url).origin },
    ]);

    const deployment = await createDeployment(token, teamId, agent.projectName, files);
    return Response.json({
      projectId: agent.projectId,
      projectName: agent.projectName,
      deploymentId: deployment.id,
      url: deployment.url,
      inspectorUrl: deployment.inspectorUrl,
      readyState: deployment.readyState,
      fromVersion: agent.currentVersion,
      toVersion: latest.version,
    });
  } catch (error) {
    if (error instanceof InspectError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof VercelApiError) {
      console.error(`update failed at ${error.stage}:`, error.message);
      return Response.json({ error: error.message, stage: error.stage }, { status: 502 });
    }
    console.error("update failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Update failed", stage: "deploy" },
      { status: 500 },
    );
  }
}
