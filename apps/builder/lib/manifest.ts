import type { FeatureId } from "./config";

// What ships in a generated deployment. The template is the live apps/eve
// source: everything ships except EXCLUDED paths, and the files listed in
// FEATURE_FILES are pruned when their feature is off. Channels and agent/lib
// modules always ship (they read env lazily and are inert without rows/keys);
// pruning only removes what eve auto-discovers and activates: tools,
// schedules, connections, extensions, and instruction fragments.
//
// scripts/check-manifest.ts asserts every prunable file in apps/eve is
// claimed by exactly one feature, so adding a tool without updating this map
// fails the build instead of silently shipping to every deployment.

/** Path prefixes / exact files never included in a deployment. */
export const EXCLUDED = [
  ".agents/",
  ".env",
  ".eve/",
  ".gitignore",
  ".next/",
  ".output/",
  ".turbo/",
  ".vercel/",
  ".DS_Store",
  "AGENTS.md",
  "CLAUDE.md",
  "PLAN.md",
  "node_modules/",
  "scripts/",
  "tsconfig.tsbuildinfo",
] as const;

/** Directories whose files must all be claimed by some feature (or core). */
export const PRUNABLE_DIRS = [
  "agent/tools/",
  "agent/schedules/",
  "agent/connections/",
  "agent/extensions/",
  "agent/instructions/",
] as const;

/** Prunable files that ship regardless of feature selection. */
export const CORE_PRUNABLE_FILES = [
  "agent/instructions/channel.ts",
  "agent/instructions/time.ts",
  "agent/tools/workflow.ts",
] as const;

/** Feature → the prunable files it owns. */
export const FEATURE_FILES: Record<FeatureId, readonly string[]> = {
  memory: [
    "agent/tools/remember.ts",
    "agent/tools/forget.ts",
    "agent/tools/search_memory.ts",
    "agent/tools/list_memories.ts",
    "agent/schedules/memory-consolidation.ts",
    "agent/instructions/memory.ts",
  ],
  proactive: [
    "agent/tools/create_reminder.ts",
    "agent/tools/cancel_reminder.ts",
    "agent/tools/list_reminders.ts",
    "agent/tools/create_webhook.ts",
    "agent/tools/list_webhooks.ts",
    "agent/tools/delete_webhook.ts",
    "agent/schedules/reminders.ts",
  ],
  receipts: [
    "agent/tools/log_receipt.ts",
    "agent/tools/query_receipts.ts",
    "agent/tools/spending_summary.ts",
    "agent/tools/delete_receipt.ts",
  ],
  skills: [
    "agent/tools/create_skill.ts",
    "agent/tools/delete_skill.ts",
    "agent/instructions/custom-skills.ts",
  ],
  "file-sharing": ["agent/tools/share_file.ts"],
  integrations: ["agent/connections/composio.ts"],
  browser: [
    "agent/extensions/browser/extension.ts",
    "agent/extensions/browser/tools/console.ts",
    "agent/extensions/browser/tools/drag.ts",
    "agent/extensions/browser/tools/hover.ts",
    "agent/extensions/browser/tools/network_requests.ts",
    "agent/extensions/browser/tools/set_checked.ts",
    "agent/extensions/browser/tools/tabs.ts",
    "agent/extensions/browser/tools/upload.ts",
  ],
  utilities: ["agent/tools/get_weather.ts", "agent/tools/roll_dice.ts"],
};

export function isExcluded(relativePath: string): boolean {
  return EXCLUDED.some(
    (entry) =>
      relativePath === entry ||
      (entry.endsWith("/") ? relativePath.startsWith(entry) : relativePath.startsWith(entry)),
  );
}

export function isPrunable(relativePath: string): boolean {
  return PRUNABLE_DIRS.some((dir) => relativePath.startsWith(dir));
}

/** The set of prunable files that ship for a feature selection. */
export function allowedPrunableFiles(features: readonly FeatureId[]): Set<string> {
  const allowed = new Set<string>(CORE_PRUNABLE_FILES);
  for (const feature of features) {
    for (const file of FEATURE_FILES[feature]) allowed.add(file);
  }
  return allowed;
}

/** Every file claimed by any feature or core — used by the completeness check. */
export function claimedPrunableFiles(): Set<string> {
  const claimed = new Set<string>(CORE_PRUNABLE_FILES);
  for (const files of Object.values(FEATURE_FILES)) {
    for (const file of files) claimed.add(file);
  }
  return claimed;
}
