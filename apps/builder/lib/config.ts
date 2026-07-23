// The wizard's output: everything needed to assemble and deploy one agent.
// Shared by the client (wizard state) and the deploy API (validation).

export const FEATURE_IDS = [
  "memory",
  "proactive",
  "receipts",
  "skills",
  "file-sharing",
  "integrations",
  "browser",
  "utilities",
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

export interface CustomSchedule {
  /** Human label; also slugified into the generated filename. */
  name: string;
  /** Five-field cron expression, evaluated in UTC on Vercel. */
  cron: string;
  /** What the agent should do when the schedule fires. */
  prompt: string;
}

/** Where the database comes from: an existing Vercel-connected store (Vercel
 * injects DATABASE_URL on connect) or a pasted connection string. */
export type PostgresSource = { mode: "connect"; storeId: string } | { mode: "manual"; url: string };

/** Where Blob storage comes from: a new store created during deploy, an
 * existing store, or a pasted token. Only consulted when a feature needs it. */
export type BlobSource =
  | { mode: "create" }
  | { mode: "connect"; storeId: string }
  | { mode: "manual"; token: string };

export interface AgentConfig {
  /** Display name of the agent (e.g. "Eve"). */
  agentName: string;
  /** Vercel project slug, derived from agentName but editable. */
  projectName: string;
  /** The human the agent works for. */
  ownerName: string;
  /** Default model id ("provider/model"), routed via the AI Gateway. */
  model: string;
  /** Enabled feature set; drives file pruning and required keys. */
  features: FeatureId[];
  /** Full instructions.md contents (generated, then user-edited). */
  instructions: string;
  /** Optional Telegram channel. */
  telegram: { botToken: string; botUsername: string; webhookSecret: string; allowedUserIds: string } | null;
  /** Custom recurring jobs compiled to defineSchedule files. */
  schedules: CustomSchedule[];
  postgres: PostgresSource;
  blob: BlobSource;
  /** Secrets, used once during deploy and never persisted. */
  keys: {
    supermemoryApiKey?: string;
    composioApiKey?: string;
  };
}

export interface DeployTarget {
  token: string;
  /** Vercel team id, or null for the personal scope. */
  teamId: string | null;
}

const MODEL_ID_PATTERN = /^[\w.-]+\/[\w.:-]+$/;
const PROJECT_NAME_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$/;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 52) || "my-eve-agent"
  );
}

/** Keys required by the current feature selection (besides the database). */
export function requiredKeys(features: readonly FeatureId[]): {
  supermemory: boolean;
  composio: boolean;
  blob: boolean;
} {
  return {
    supermemory: features.includes("memory"),
    composio: features.includes("integrations"),
    blob: features.includes("skills") || features.includes("file-sharing"),
  };
}

/** Validates a wizard config server-side; returns a problem or null. */
export function validateConfig(config: AgentConfig): string | null {
  if (config.agentName.trim().length === 0) return "Agent name is required";
  if (!PROJECT_NAME_PATTERN.test(config.projectName)) {
    return "Project name must be lowercase letters, digits, and dashes";
  }
  if (config.ownerName.trim().length === 0) return "Owner name is required";
  if (!MODEL_ID_PATTERN.test(config.model)) return "Model must look like provider/model";
  if (config.instructions.trim().length === 0) return "Instructions are required";
  if (config.postgres.mode === "manual" && config.postgres.url.trim().length === 0) {
    return "Postgres connection string is required";
  }
  if (config.postgres.mode === "connect" && config.postgres.storeId.trim().length === 0) {
    return "Pick a database to connect";
  }
  for (const feature of config.features) {
    if (!FEATURE_IDS.includes(feature)) return `Unknown feature: ${feature}`;
  }
  const keys = requiredKeys(config.features);
  if (keys.supermemory && !config.keys.supermemoryApiKey?.trim()) {
    return "Memory needs a Supermemory API key";
  }
  if (keys.composio && !config.keys.composioApiKey?.trim()) {
    return "App integrations need a Composio API key";
  }
  if (keys.blob) {
    if (config.blob.mode === "manual" && config.blob.token.trim().length === 0) {
      return "Skills and file sharing need a Vercel Blob token";
    }
    if (config.blob.mode === "connect" && config.blob.storeId.trim().length === 0) {
      return "Pick a Blob store to connect";
    }
  }
  if (config.telegram !== null && config.telegram.botToken.trim().length === 0) {
    return "Telegram needs a bot token";
  }
  return null;
}
