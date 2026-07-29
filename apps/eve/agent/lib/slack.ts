/**
 * Slack deployment configuration: who the owner is, and which Vercel Connect
 * client holds the workspace's bot token. Both are environment-only — there is
 * no in-app flow to set them, because Connect owns the credential and the
 * owner's Slack user id is an identity claim the app must not let itself
 * change.
 */

/** Trimmed env value, or null when unset or blank. */
function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

/** The Connect client UID holding the Slack bot token. */
export function slackConnectClientId(): string {
  return env("SLACK_CONNECT_CLIENT_ID") ?? "slack/ruth";
}

/**
 * The owner's Slack user id, or null when unset.
 *
 * Null is the safe direction: no real user id equals null, so an unconfigured
 * deployment treats everyone as a guest — owner-only tools stay denied and
 * owner-only reaction rules stop firing — rather than handing a stranger the
 * agent's wallet.
 */
export function ownerSlackUserId(): string | null {
  return env("SLACK_OWNER_USER_ID");
}

/** True when the given Slack user id is the configured owner. */
export function isOwnerSlackUser(userId: string): boolean {
  const owner = ownerSlackUserId();
  return owner !== null && owner === userId;
}

/**
 * Whether this deployment has been pointed at a Connect client at all.
 *
 * Deliberately keyed on the env var's presence rather than the resolved value
 * of {@link slackConnectClientId}, which always returns a string: a deployment
 * that never set up Connect should not advertise Slack in the manage UI.
 */
export function slackConfigured(): boolean {
  return env("SLACK_CONNECT_CLIENT_ID") !== null;
}
