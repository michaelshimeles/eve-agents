import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { CustomSchedule, FeatureId } from "./config";
import { allowedPrunableFiles, isExcluded, isPrunable } from "./manifest";
import { generateScheduleFile, scheduleSlug } from "./schedule-codegen";

// Turns the live apps/eve source into the file set for one configured
// deployment: walk, filter (exclusions + feature pruning), transform
// (instructions, package name), and append generated schedule files plus a
// small manifest (eve-builder.json) describing what was deployed.

export interface DeployFile {
  /** Path inside the deployment, POSIX-style. */
  file: string;
  /** Base64 contents (works uniformly for text and binary). */
  data: string;
  encoding: "base64";
}

/**
 * Baked into every deployment so the update flow can read a deployed agent's
 * configuration back out of its own files (via the Vercel deployment-files
 * API) — the builder stores nothing, so the deployment is the record.
 */
export const BUILDER_MANIFEST_FILE = "eve-builder.json";

/** Checked into apps/eve; bump when shipping a template change that agents should pick up. */
export const TEMPLATE_RELEASE_FILE = ".eve-template-release";

export interface BuilderManifest {
  templateVersion: string;
  /** Monotonic release from apps/eve/.eve-template-release — orders updates safely. */
  templateRelease: number;
  features: FeatureId[];
  projectName: string;
  deployedAt: string;
}

export interface TemplateInfo {
  version: string;
  /** Integer from apps/eve/.eve-template-release; must increase for an update to be offered. */
  release: number;
}

/**
 * What assembly actually needs — a structural subset of the wizard's
 * AgentConfig, so the update flow (which reconstructs these fields from a
 * deployed agent) can assemble without the rest of the config.
 */
export interface AssembleInput {
  projectName: string;
  features: readonly FeatureId[];
  instructions: string;
  schedules: readonly CustomSchedule[];
}

/** Locates apps/eve both in dev (cwd = apps/builder) and in the traced Vercel bundle. */
export async function templateRoot(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), "../eve"),
    path.resolve(process.cwd(), "apps/eve"),
    path.resolve(process.cwd(), "../../apps/eve"),
  ];
  for (const candidate of candidates) {
    try {
      const probe = await stat(path.join(candidate, "agent", "agent.ts"));
      if (probe.isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error("Could not locate the apps/eve template source");
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const probe = entry.isDirectory() ? `${relative}/` : relative;
    if (isExcluded(probe)) continue;
    if (entry.isDirectory()) {
      await walk(root, absolute, out);
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
}

/**
 * Template identity for update detection: a content hash (display / equality)
 * plus a checked-in monotonic release integer (ordering). Deployed agents
 * only offer an update when latest.release > current.release, so restoring
 * older template files — even with newer filesystem mtimes — can't look like
 * an upgrade. Bump apps/eve/.eve-template-release when shipping changes.
 *
 * Only successful results are cached — a transient FS error must not poison
 * every later deploy/update on this serverless instance.
 */
let cachedTemplateInfo: TemplateInfo | null = null;
let templateInfoInflight: Promise<TemplateInfo> | null = null;
export function templateInfo(): Promise<TemplateInfo> {
  if (cachedTemplateInfo !== null) return Promise.resolve(cachedTemplateInfo);
  templateInfoInflight ??= (async () => {
    try {
      const root = await templateRoot();
      const files: string[] = [];
      await walk(root, root, files);
      const hash = createHash("sha256");
      for (const relative of files.sort()) {
        hash.update(relative);
        hash.update("\0");
        hash.update(await readFile(path.join(root, relative)));
      }
      const releaseRaw = (await readFile(path.join(root, TEMPLATE_RELEASE_FILE), "utf8")).trim();
      const release = Number.parseInt(releaseRaw, 10);
      if (!Number.isFinite(release) || release < 1) {
        throw new Error(
          `${TEMPLATE_RELEASE_FILE} must contain a positive integer (got ${JSON.stringify(releaseRaw)})`,
        );
      }
      const info: TemplateInfo = {
        version: hash.digest("hex").slice(0, 12),
        release,
      };
      cachedTemplateInfo = info;
      return info;
    } finally {
      templateInfoInflight = null;
    }
  })();
  return templateInfoInflight;
}

export async function templateVersion(): Promise<string> {
  return (await templateInfo()).version;
}

/** All template file paths that ship for this feature selection (pre-transform). */
export async function templateFiles(features: readonly FeatureId[]): Promise<string[]> {
  const root = await templateRoot();
  const files: string[] = [];
  await walk(root, root, files);
  const allowed = allowedPrunableFiles(features);
  return files.filter((file) => !isPrunable(file) || allowed.has(file)).sort();
}

/** Assembles the complete deployment file set for the Vercel API. */
export async function assembleDeployment(input: AssembleInput): Promise<DeployFile[]> {
  const root = await templateRoot();
  const paths = await templateFiles(input.features);
  const out: DeployFile[] = [];

  for (const relative of paths) {
    let data: Buffer = await readFile(path.join(root, relative));

    if (relative === "agent/instructions.md") {
      data = Buffer.from(input.instructions, "utf8");
    } else if (relative === "package.json") {
      const parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      parsed.name = input.projectName;
      data = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    }

    out.push({ file: relative, data: data.toString("base64"), encoding: "base64" });
  }

  const usedSlugs = new Set<string>();
  input.schedules.forEach((schedule, index) => {
    let slug = scheduleSlug(schedule.name, index);
    while (usedSlugs.has(slug)) slug = `${slug}-${index + 1}`;
    usedSlugs.add(slug);
    out.push({
      file: `agent/schedules/custom-${slug}.ts`,
      data: Buffer.from(generateScheduleFile(schedule), "utf8").toString("base64"),
      encoding: "base64",
    });
  });

  const info = await templateInfo();
  const manifest: BuilderManifest = {
    templateVersion: info.version,
    templateRelease: info.release,
    features: [...input.features],
    projectName: input.projectName,
    deployedAt: new Date().toISOString(),
  };
  out.push({
    file: BUILDER_MANIFEST_FILE,
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8").toString("base64"),
    encoding: "base64",
  });

  return out;
}
