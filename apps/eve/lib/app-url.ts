/**
 * This app's public origin, as the browser that sent `request` sees it.
 *
 * Behind Vercel's proxy the request URL carries an internal host, so the
 * forwarded headers win when present. Needed wherever a URL has to survive a
 * round trip through someone else's service (an OAuth redirect URI, for
 * instance), which rules out a relative path.
 */
export function requestOrigin(request: Request): string {
  const headers = request.headers;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (host !== null && host.length > 0) {
    const proto =
      headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
      (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}
