import { verifyHttpBasic } from "eve/channels/auth";

export const WEB_OWNER_PRINCIPAL_ID = "web:owner";

export interface WebPrincipal {
  readonly principalId: typeof WEB_OWNER_PRINCIPAL_ID;
}

export type WebAuthentication = WebPrincipal | Response;

function configuredCredentials(): {
  readonly username: string;
  readonly password: string;
} | null {
  const username = process.env.WEB_AUTH_USERNAME?.trim();
  const password = process.env.WEB_AUTH_PASSWORD?.trim();
  return username && password ? { username, password } : null;
}

function isLoopback(request: Request): boolean {
  if ((process.env.VERCEL ?? "").length > 0) return false;
  if (process.env.NODE_ENV === "production") return false;
  if (request.headers.get("x-forwarded-for") !== null) return false;
  try {
    const { hostname } = new URL(request.url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function unauthorized(message: string, status = 401): Response {
  return Response.json(
    { error: message, authRequired: true },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(status === 401
          ? {
              "www-authenticate":
                'Basic realm="Ruth", charset="UTF-8"',
            }
          : {}),
      },
    },
  );
}

/**
 * Authenticates the single owner of this personal assistant.
 *
 * Production fails closed unless both WEB_AUTH_USERNAME and
 * WEB_AUTH_PASSWORD are configured. Loopback development remains available
 * without a credential; forwarded or deployed requests never inherit that
 * exception.
 */
export function authenticateWebRequest(request: Request): WebAuthentication {
  if (isLoopback(request) || process.env.NODE_ENV === "test") {
    return { principalId: WEB_OWNER_PRINCIPAL_ID };
  }

  const credentials = configuredCredentials();
  if (credentials === null) {
    return unauthorized(
      "Web access is locked. Configure WEB_AUTH_USERNAME and WEB_AUTH_PASSWORD.",
      503,
    );
  }
  const result = verifyHttpBasic(
    request.headers.get("authorization"),
    credentials,
  );
  return result.ok
    ? { principalId: WEB_OWNER_PRINCIPAL_ID }
    : unauthorized("Authentication is required.");
}

/** Guards Next.js route handlers that only need an allow/deny decision. */
export function requireWebAuth(request: Request): Response | null {
  const result = authenticateWebRequest(request);
  return result instanceof Response ? result : null;
}
