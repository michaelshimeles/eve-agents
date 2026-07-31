export const WEB_OWNER_PRINCIPAL_ID = "web:owner";

export type OwnerAccess = "allowed" | "forbidden" | "signed-out" | "unconfigured";

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

/** The one Clerk user allowed to use Ruth's private web surfaces. */
export function configuredClerkOwnerId(): string | null {
  return trimmedEnv("CLERK_OWNER_USER_ID");
}

/** Pure policy shared by Next.js routes and the Eve HTTP channel. */
export function ownerAccessFor(ownerId: string | null, userId: string | null): OwnerAccess {
  if (ownerId === null) return "unconfigured";
  if (userId === null) return "signed-out";
  return userId === ownerId ? "allowed" : "forbidden";
}
