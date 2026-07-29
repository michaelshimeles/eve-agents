import { ownerSlackChannelId } from "@/agent/lib/delivery";
import { ownerSlackUserId, slackConfigured } from "@/agent/lib/slack";
import {
  listSlackReactionRules,
  setSlackReactionRules,
  type SlackReactionRule,
} from "@/agent/lib/slack-reactions";
import { requireWebAuth } from "@/lib/web-auth";

// Manage -> Slack: setup status plus the owner's emoji-reaction rules.
//
// Credentials and the owner's Slack user id are environment-only (Vercel
// Connect holds the bot token), so this route reports on them but cannot
// change them. The rules are app-managed settings, so they need DATABASE_URL —
// without one, the panel renders read-only and says why.
//
// Kept as plain TypeScript rather than an Effect program because its domain
// lib (agent/lib/slack-reactions.ts) rides on the still-legacy settings store,
// matching /api/automations and /api/computer. It moves onto the Effect
// boundary when settings-db.ts does.

interface SlackStatus {
  /** Settings can be stored at all. */
  hasDatabase: boolean;
  /** SLACK_CONNECT_CLIENT_ID is set, so the channel has credentials. */
  configured: boolean;
  /** SLACK_OWNER_USER_ID is set, so someone can be the owner. */
  ownerConfigured: boolean;
  /** The owner's DM is known, so proactive delivery to Slack would work. */
  linked: boolean;
  rules: SlackReactionRule[];
}

function hasDatabase(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const [rules, channelId] = await Promise.all([
    listSlackReactionRules(),
    ownerSlackChannelId().catch(() => null),
  ]);
  const status: SlackStatus = {
    hasDatabase: hasDatabase(),
    configured: slackConfigured(),
    ownerConfigured: ownerSlackUserId() !== null,
    linked: channelId !== null,
    rules,
  };
  return Response.json(status);
}

export async function PUT(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  // Checked up front so "you have no database" reads as a 503 rather than
  // arriving as a validation-shaped 400 from the settings store.
  if (!hasDatabase()) {
    return Response.json(
      { error: "No database is configured, so reaction rules cannot be saved." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Expected a JSON object." }, { status: 400 });
  }

  // Whole-list replacement rather than per-rule endpoints: the value is a
  // single settings row, so a partial update would race against itself.
  try {
    const rules = await setSlackReactionRules((body as { rules?: unknown }).rules);
    return Response.json({ rules });
  } catch (error) {
    // Every throw out of setSlackReactionRules past the database check is a
    // validation failure, and its message names the offending rule.
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
