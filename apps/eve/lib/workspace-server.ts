import type { WorkspaceTarget } from "@/lib/workspace-api";
import {
  authenticateWorkspaceRequest,
  type WorkspaceAuthentication,
  type WorkspacePrincipal,
} from "@/lib/workspace-auth";
import { workspaceSessionOwnedBy } from "@/lib/threads-db";

export function workspaceTargetFromUrl(url: URL): WorkspaceTarget {
  const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
  if (sessionId.length === 0 || sessionId.length > 256) {
    throw new Error("A valid Eve sessionId is required.");
  }
  const targetName = url.searchParams.get("targetName")?.trim();
  if (targetName !== undefined && targetName.length > 128) {
    throw new Error("The workspace target name is invalid.");
  }
  return {
    sessionId,
    ...(targetName ? { targetName } : {}),
  };
}

export function workspaceTargetFromBody(value: unknown): WorkspaceTarget {
  if (value === null || typeof value !== "object") {
    throw new Error("A valid workspace target is required.");
  }
  const target = value as Partial<WorkspaceTarget>;
  if (
    typeof target.sessionId !== "string" ||
    target.sessionId.trim().length === 0 ||
    target.sessionId.length > 256
  ) {
    throw new Error("A valid Eve sessionId is required.");
  }
  if (
    target.targetName !== undefined &&
    (typeof target.targetName !== "string" ||
      target.targetName.length === 0 ||
      target.targetName.length > 128)
  ) {
    throw new Error("The workspace target name is invalid.");
  }
  return {
    sessionId: target.sessionId,
    ...(target.targetName ? { targetName: target.targetName } : {}),
  };
}

export function requireWorkspaceRequest(
  request: Request,
  mutation = false,
): WorkspaceAuthentication {
  const authentication = authenticateWorkspaceRequest(request);
  if (authentication instanceof Response || !mutation) return authentication;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  // Next may reconstruct request.url with an internal/proxied host. Browsers set
  // Sec-Fetch-Site themselves (page JavaScript cannot forge it), so this keeps
  // same-origin mutations working through previews and reverse proxies without
  // weakening the explicit Origin check for non-browser clients.
  if (
    origin !== null &&
    fetchSite !== "same-origin" &&
    origin !== new URL(request.url).origin
  ) {
    return Response.json({ error: "Cross-origin workspace requests are not allowed." }, { status: 403 });
  }
  return authentication;
}

/**
 * Authorizes a parsed target before any Vercel Sandbox lookup or mutation.
 * The public boundary is deliberately two-part: the admin secret proves the
 * single owner, then the durable thread row proves this session is theirs.
 */
export async function authorizeWorkspaceTarget(
  principal: WorkspacePrincipal,
  target: WorkspaceTarget,
): Promise<Response | null> {
  if (!principal.durableOwnershipRequired) return null;
  if (!process.env.DATABASE_URL) {
    return Response.json(
      {
        error:
          "Secure workspace access requires DATABASE_URL so conversations can be bound to their owner.",
      },
      { status: 503 },
    );
  }
  try {
    if (await workspaceSessionOwnedBy(principal.principalId, target.sessionId)) {
      return null;
    }
  } catch {
    return Response.json(
      { error: "Workspace ownership could not be verified." },
      { status: 503 },
    );
  }
  return Response.json(
    { error: "This conversation is not available to the authenticated workspace owner." },
    { status: 403 },
  );
}

export function workspaceApiFailure(error: unknown): Response {
  const rawMessage = error instanceof Error ? error.message : "Workspace request failed.";
  const normalized = rawMessage.toLowerCase();
  const tagged =
    error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "SandboxWorkspaceError" &&
    "kind" in error &&
    typeof error.kind === "string";
  const kind = tagged ? error.kind : null;
  const status =
    kind === "invalid"
      ? 400
      : kind === "not_started" || kind === "not_found"
        ? 404
        : kind === "conflict"
          ? 409
          : kind === "too_large"
            ? 413
            : kind === "credentials"
              ? 503
              : kind === "provider"
                ? 502
                : normalized.includes("cross-origin")
      ? 403
      : normalized.includes("has not used") || normalized.includes("not found") || normalized.includes("no longer exists")
        ? 404
        : normalized.includes("changed") ||
            normalized.includes("already exists") ||
            normalized.includes("current snapshot")
          ? 409
          : normalized.includes("too large") || normalized.includes("larger than")
            ? 413
            : normalized.includes("credential") || normalized.includes("oidc")
              ? 503
              : normalized.includes("invalid") ||
                  normalized.includes("required") ||
                  normalized.includes("cannot") ||
                  normalized.includes("must") ||
                  normalized.includes("type the")
                ? 400
                : 502;
  const message =
    status === 400 || status === 403 || status === 404 || status === 409 || status === 413
      ? rawMessage
      : status === 503
        ? "Vercel Sandbox credentials are not available for this deployment."
        : "Workspace request failed.";
  return Response.json({ error: message }, { status });
}

export function workspaceSocketUrl(request: Request): URL {
  const url = new URL(request.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}
