import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { TEMPLATE_RELEASE_FILE } from "../lib/assemble";
import { claimedPrunableFiles, PRUNABLE_DIRS } from "../lib/manifest";

// Guards the "apps/eve is the template" invariant: every file that eve
// auto-discovers (tools, schedules, connections, extensions, instruction
// fragments) must be claimed by exactly one feature in lib/manifest.ts (or
// core). Runs as part of `npm run typecheck` so a new tool added to the
// personal app fails CI until the builder knows which feature owns it.

const eveRoot = path.resolve(import.meta.dirname, "../../eve");

async function listPrunable(): Promise<string[]> {
  const found: string[] = [];
  for (const dir of PRUNABLE_DIRS) {
    const absolute = path.join(eveRoot, dir);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) found.push(`${dir}${entry.name}`);
    }
  }
  return found;
}

const actual = await listPrunable();
const claimed = claimedPrunableFiles();

const unclaimed = actual.filter((file) => !claimed.has(file));
const stale = [...claimed].filter((file) => !actual.includes(file));

if (unclaimed.length > 0) {
  console.error(
    "Unclaimed prunable files — add them to a feature (or core) in apps/builder/lib/manifest.ts:",
  );
  for (const file of unclaimed) console.error(`  - ${file}`);
}
if (stale.length > 0) {
  console.error("Manifest claims files that no longer exist in apps/eve:");
  for (const file of stale) console.error(`  - ${file}`);
}
if (unclaimed.length > 0 || stale.length > 0) process.exit(1);

const releaseRaw = (await readFile(path.join(eveRoot, TEMPLATE_RELEASE_FILE), "utf8").catch(() => "")).trim();
const release = Number.parseInt(releaseRaw, 10);
if (!Number.isFinite(release) || release < 1) {
  console.error(
    `${TEMPLATE_RELEASE_FILE} must contain a positive integer (got ${JSON.stringify(releaseRaw)}). Bump it when shipping template changes agents should pick up.`,
  );
  process.exit(1);
}

console.log(`manifest ok: ${actual.length} prunable files, all claimed; template release ${release}`);
