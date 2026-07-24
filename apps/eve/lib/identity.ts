/**
 * Display identity for this deployment. The agent builder sets
 * NEXT_PUBLIC_AGENT_NAME / NEXT_PUBLIC_OWNER_NAME per deployment; the
 * personal app falls back to its own names. NEXT_PUBLIC_* values are inlined
 * at build time, so these constants work in server and client components.
 */
function pick(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : fallback;
}

export const AGENT_NAME = pick(process.env.NEXT_PUBLIC_AGENT_NAME, "Ruth");
export const OWNER_NAME = pick(process.env.NEXT_PUBLIC_OWNER_NAME, "Micky");
