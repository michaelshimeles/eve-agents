import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Give every universal iMessage interaction page a per-request script nonce.
 * Next reads the request CSP and applies that nonce to framework scripts, so
 * capability-bearing Mini App pages never need `script-src 'unsafe-inline'`.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(randomUUID()).toString("base64");
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Kumo and React use generated style attributes. Scripts still require the
    // per-request nonce; styles are limited to this origin and inline values.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: "/imessage/apps/:path*",
};
