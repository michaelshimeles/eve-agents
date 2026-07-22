import { timingSafeEqual } from "node:crypto";

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="eve-agent"' },
  });
}

function safeEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Guards Next.js route handlers with HTTP Basic credentials
 * (EVE_WEB_USERNAME / EVE_WEB_PASSWORD). Returns a 401 response to send, or
 * null when the request is allowed. The API routes expose sensitive reads
 * (webhook URLs embed secrets) and destructive deletes, so this fails closed
 * in production when the env vars are missing.
 */
export function requireWebAuth(request: Request): Response | null {
  // Open during local development, mirroring the eve channel's localDev().
  if (process.env.NODE_ENV !== "production") return null;
  const username = process.env.EVE_WEB_USERNAME;
  const password = process.env.EVE_WEB_PASSWORD;
  // Fail closed if the deployment is missing its credentials.
  if (!username || !password) return unauthorized();
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const provided = request.headers.get("authorization");
  return provided !== null && safeEqual(expected, provided) ? null : unauthorized();
}
