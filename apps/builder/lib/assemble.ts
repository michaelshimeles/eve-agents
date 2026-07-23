import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "./config";
import { allowedPrunableFiles, isExcluded, isPrunable } from "./manifest";
import { generateScheduleFile, scheduleSlug } from "./schedule-codegen";

// Turns the live apps/eve source into the file set for one configured
// deployment: walk, filter (exclusions + feature pruning), transform
// (instructions, package name), and append generated schedule files.

export interface DeployFile {
  /** Path inside the deployment, POSIX-style. */
  file: string;
  /** Base64 contents (works uniformly for text and binary). */
  data: string;
  encoding: "base64";
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

/** All template file paths that ship for this feature selection (pre-transform). */
export async function templateFiles(config: AgentConfig): Promise<string[]> {
  const root = await templateRoot();
  const files: string[] = [];
  await walk(root, root, files);
  const allowed = allowedPrunableFiles(config.features);
  return files.filter((file) => !isPrunable(file) || allowed.has(file)).sort();
}

/** Assembles the complete deployment file set for the Vercel API. */
export async function assembleDeployment(config: AgentConfig): Promise<DeployFile[]> {
  const root = await templateRoot();
  const paths = await templateFiles(config);
  const out: DeployFile[] = [];

  for (const relative of paths) {
    let data: Buffer = await readFile(path.join(root, relative));

    if (relative === "agent/instructions.md") {
      data = Buffer.from(config.instructions, "utf8");
    } else if (relative === "package.json") {
      const parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      parsed.name = config.projectName;
      data = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    }

    out.push({ file: relative, data: data.toString("base64"), encoding: "base64" });
  }

  const usedSlugs = new Set<string>();
  config.schedules.forEach((schedule, index) => {
    let slug = scheduleSlug(schedule.name, index);
    while (usedSlugs.has(slug)) slug = `${slug}-${index + 1}`;
    usedSlugs.add(slug);
    out.push({
      file: `agent/schedules/custom-${slug}.ts`,
      data: Buffer.from(generateScheduleFile(schedule), "utf8").toString("base64"),
      encoding: "base64",
    });
  });

  return out;
}
