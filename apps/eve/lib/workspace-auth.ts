import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  WEB_OWNER_PRINCIPAL_ID,
  type WebPrincipal,
} from "@/lib/web-auth";
import { WORKSPACE_ADMIN_HEADER } from "@/lib/workspace-api";

export const WORKSPACE_AUTH_COOKIE = "ruth-workspace-owner";

const COOKIE_VERSION = "v1";
const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

export interface WorkspacePrincipal extends WebPrincipal {
  /**
   * Loopback development is already isolated by the host boundary. Public
   * deployments additionally prove that the requested Eve session belongs to
   * this principal in the durable thread store.
   */
  readonly durableOwnershipRequired: boolean;
}

export type WorkspaceAuthentication = WorkspacePrincipal | Response;

function configuredToken(): string | null {
  const token = process.env.WORKSPACE_ADMIN_TOKEN?.trim();
  return token === undefined || token.length === 0 ? null : token;
}

function fixedWidthMatch(expected: string, provided: string): boolean {
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

function cookieCredential(token: string): string {
  const digest = createHmac("sha256", token)
    .update("ruth-workspace-owner-cookie")
    .digest("base64url");
  return `${COOKIE_VERSION}.${digest}`;
}

function cookieValue(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (raw === null) return null;
  for (const part of raw.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === WORKSPACE_AUTH_COOKIE) return value.join("=") || null;
  }
  return null;
}

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

function owner(durableOwnershipRequired: boolean): WorkspacePrincipal {
  return {
    principalId: WEB_OWNER_PRINCIPAL_ID,
    durableOwnershipRequired,
  };
}

function authFailure(
  error: string,
  status: 401 | 503,
  authConfigured: boolean,
): Response {
  return Response.json(
    {
      error,
      authRequired: true,
      authConfigured,
    },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}

/**
 * Authenticates the single owner for every workspace HTTP and WebSocket route.
 *
 * The rest of Ruth's web app intentionally remains open. Workspace access is
 * different: it exposes a shell and arbitrary filesystem writes, so public
 * deployments fail closed behind their own secret. A successful unlock mints
 * an HttpOnly cookie, which also authenticates browser WebSocket handshakes.
 */
export function authenticateWorkspaceRequest(
  request: Request,
): WorkspaceAuthentication {
  if (isLoopback(request)) return owner(false);

  const expected = configuredToken();
  if (expected === null) {
    return authFailure(
      "Workspace access is locked. Configure WORKSPACE_ADMIN_TOKEN on this deployment.",
      503,
      false,
    );
  }

  const header = request.headers.get(WORKSPACE_ADMIN_HEADER);
  const cookie = cookieValue(request);
  if (
    (header !== null && fixedWidthMatch(expected, header)) ||
    (cookie !== null &&
      fixedWidthMatch(cookieCredential(expected), cookie))
  ) {
    return owner(true);
  }

  return authFailure(
    "Enter this deployment's workspace admin token to continue.",
    401,
    true,
  );
}

function sameOriginLogin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}

/**
 * Exchanges the configured admin token for a scoped HttpOnly owner cookie.
 * The raw token is accepted once and is never persisted in browser storage.
 */
export function createWorkspaceLoginResponse(request: Request): Response {
  if (isLoopback(request)) return Response.json({ ok: true });
  if (!sameOriginLogin(request)) {
    return Response.json(
      { error: "Workspace unlock must come from the app itself in a browser." },
      { status: 403 },
    );
  }

  const expected = configuredToken();
  if (expected === null) {
    return authFailure(
      "Workspace access is locked. Configure WORKSPACE_ADMIN_TOKEN on this deployment.",
      503,
      false,
    );
  }
  const provided = request.headers.get(WORKSPACE_ADMIN_HEADER);
  if (provided === null || !fixedWidthMatch(expected, provided)) {
    return authFailure("That workspace admin token is not correct.", 401, true);
  }

  const secure =
    new URL(request.url).protocol === "https:" ||
    (process.env.VERCEL ?? "").length > 0;
  const cookie = [
    `${WORKSPACE_AUTH_COOKIE}=${cookieCredential(expected)}`,
    "Path=/api/workspace",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
  return Response.json(
    { ok: true },
    {
      headers: {
        "cache-control": "no-store",
        "set-cookie": cookie,
      },
    },
  );
}
