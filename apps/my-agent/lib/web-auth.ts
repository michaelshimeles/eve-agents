function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="eve-agent"' },
  });
}

/**
 * Guards Next.js route handlers with the same HTTP Basic credentials the eve
 * channel uses. Returns a 401 response to send, or null when the request is
 * allowed. Fails closed in production if the env vars are missing.
 */
export function requireWebAuth(request: Request): Response | null {
  // Open during local development, mirroring the eve channel's localDev().
  if (process.env.NODE_ENV !== "production") return null;
  const username = process.env.EVE_WEB_USERNAME;
  const password = process.env.EVE_WEB_PASSWORD;
  // Fail closed if the deployment is missing its credentials.
  if (!username || !password) return unauthorized();
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  return request.headers.get("authorization") === expected ? null : unauthorized();
}
