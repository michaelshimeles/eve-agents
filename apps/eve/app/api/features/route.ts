import { orgoConfigured } from "@/agent/lib/orgo";
import { requireWebAuth } from "@/lib/web-auth";

// Which optional capabilities this deployment actually has, so the UI can
// hide surfaces that would always be empty. Two inputs: the feature list the
// agent builder baked into the deployment (EVE_ENABLED_FEATURES, unset =
// everything, which is what the personal app runs with) and the presence of
// the env keys a feature needs at runtime.

const ALL_FEATURES = [
  "memory",
  "proactive",
  "receipts",
  "skills",
  "file-sharing",
  "integrations",
  "browser",
  "computer",
  "utilities",
  "email",
  "card",
  "imessage",
  "slack",
  "voice",
] as const;

function enabledSet(): Set<string> {
  const raw = process.env.EVE_ENABLED_FEATURES;
  if (raw === undefined || raw.trim().length === 0) return new Set(ALL_FEATURES);
  return new Set(
    raw
      .split(",")
      .map((feature) => feature.trim())
      .filter((feature) => feature.length > 0),
  );
}

function hasEnv(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value.length > 0;
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const on = enabledSet();
  return Response.json({
    memory: on.has("memory") && hasEnv("SUPERMEMORY_API_KEY"),
    proactive: on.has("proactive"),
    integrations: on.has("integrations") && hasEnv("COMPOSIO_API_KEY"),
    skills: on.has("skills") && hasEnv("BLOB_READ_WRITE_TOKEN"),
    // Not gated on AGENTMAIL_API_KEY: the email page is where you find out you
    // need one, so hiding it until the key exists would hide the instructions.
    email: on.has("email"),
    // Configured means a key exists (environment or app settings); available
    // means the deployment ships the feature at all. The manage tab shows on
    // available so a key can be added there in the first place.
    computer: on.has("computer") && (await orgoConfigured()),
    computerAvailable: on.has("computer"),
    // Availability only: the card tab is where the Agentcard connection is
    // made, so hiding it until one exists would hide the way to make one.
    cardAvailable: on.has("card"),
    // Same idea: the iMessage tab is where pairing happens.
    imessageAvailable: on.has("imessage"),
    // Configured gates the delivery option (a Connect client means the channel
    // has credentials); available gates the tab, which is where reaction rules
    // are written — hiding it until Connect is set up would hide half the
    // reason to set Connect up.
    slack: on.has("slack") && hasEnv("SLACK_CONNECT_CLIENT_ID"),
    slackAvailable: on.has("slack"),
    voice: on.has("voice") && hasEnv("OPENAI_API_KEY"),
  });
}
