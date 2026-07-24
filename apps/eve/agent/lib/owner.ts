/**
 * Who this agent is and who it works for. Deployments created by the agent
 * builder set OWNER_NAME / NEXT_PUBLIC_AGENT_NAME (and NEXT_PUBLIC_OWNER_NAME
 * for the web UI); the personal app falls back to its original identity.
 */
function pick(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : fallback;
}

/** The human this agent works for. */
export function ownerName(): string {
  return pick(process.env.OWNER_NAME ?? process.env.NEXT_PUBLIC_OWNER_NAME, "Micky");
}

/** The agent's own display name (push titles, tool copy). */
export function agentName(): string {
  return pick(process.env.NEXT_PUBLIC_AGENT_NAME, "Ruth");
}
