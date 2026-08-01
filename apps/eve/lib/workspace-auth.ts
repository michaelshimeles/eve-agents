import {
  requireWebAuth,
  WEB_OWNER_PRINCIPAL_ID,
  type WebPrincipal,
} from "@/lib/web-auth";

export interface WorkspacePrincipal extends WebPrincipal {
  /**
   * Public deployments additionally prove that the requested Eve session
   * belongs to the signed-in owner in the durable thread store.
   */
  readonly durableOwnershipRequired: boolean;
}

export type WorkspaceAuthentication = WorkspacePrincipal | Response;

function isLoopback(request: Request): boolean {
  // A deployed function may reconstruct its internal URL with a loopback
  // hostname, so deployment and forwarded-request evidence always wins.
  if ((process.env.VERCEL ?? "").length > 0) return false;
  if (process.env.NODE_ENV === "production") return false;
  if (request.headers.get("x-forwarded-for") !== null) return false;
  try {
    const hostname = new URL(request.url).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/** Authenticate the configured Clerk owner for every workspace route. */
export async function authenticateWorkspaceRequest(
  request: Request,
): Promise<WorkspaceAuthentication> {
  const denied = await requireWebAuth(request);
  if (denied !== null) return denied;
  return {
    principalId: WEB_OWNER_PRINCIPAL_ID,
    durableOwnershipRequired: !isLoopback(request),
  };
}
