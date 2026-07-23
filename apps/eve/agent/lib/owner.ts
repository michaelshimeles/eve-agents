/**
 * The human this agent works for. Deployments created by the agent builder
 * set OWNER_NAME; the personal app falls back to its original owner.
 */
export function ownerName(): string {
  const name = process.env.OWNER_NAME?.trim();
  return name !== undefined && name.length > 0 ? name : "Micky";
}
