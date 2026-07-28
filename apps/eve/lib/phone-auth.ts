import { createHash, timingSafeEqual } from "node:crypto";

// Authorization for phone management.
//
// These operations are not like the rest of the manage surface: they rotate an
// API credential, buy a number that bills monthly, release the line the agent
// answers on, and decide whose texts count as the owner's. The app as a whole
// is unauthenticated by design (`lib/web-auth.ts` no-ops and the eve channel
// admits anonymous callers), so this route brings its own gate rather than
// inheriting one that permits everybody.
//
// It fails CLOSED. With no token configured, a deployment reachable from the
// internet refuses every mutation and says how to enable them. The only
// exception is a loopback request, because `next dev` on your own machine is
// not a threat model and the alternative is being unable to develop.

export const PHONE_ADMIN_HEADER = "x-phone-admin-token";

function configuredToken(): string | null {
  const token = process.env.AGENTPHONE_ADMIN_TOKEN?.trim();
  return token === undefined || token.length === 0 ? null : token;
}

/** Whether this deployment has an admin token at all. */
export function phoneAdminConfigured(): boolean {
  return configuredToken() !== null;
}

/**
 * Compares through fixed-width hashes so a length mismatch cannot short
 * circuit, and so `timingSafeEqual` never throws on unequal buffers.
 */
function tokensMatch(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

/** True for requests that reached us over loopback rather than the internet. */
function isLoopback(request: Request): boolean {
  // Never on a deployment, whatever the URL looks like. A serverless runtime
  // can present an internal localhost origin to the handler, and treating
  // that as local trust would hand the unlocked panel to the whole internet.
  if ((process.env.VERCEL ?? "").length > 0) return false;
  if (process.env.NODE_ENV === "production") return false;
  // A forwarded request has passed through a proxy, so it did not originate
  // locally no matter what the Host says.
  if (request.headers.get("x-forwarded-for") !== null) return false;
  try {
    const { hostname } = new URL(request.url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Rejects cross-site callers.
 *
 * Every browser since 2020 sends `Sec-Fetch-Site` on every request and page
 * script cannot forge it, so requiring it to be present and same-origin turns
 * away both a cross-origin page driving this from someone's browser and a
 * plain scripted call, which sends no such header at all.
 */
function rejectCrossSite(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return null;
  return Response.json(
    { error: "This action must come from the app itself in a browser." },
    { status: 403 },
  );
}

/**
 * Guards a state-changing phone request. Returns a `Response` to send when the
 * caller may not proceed, or `null` when they may.
 */
export function requirePhoneAdmin(request: Request): Response | null {
  const crossSite = rejectCrossSite(request);
  if (crossSite !== null) return crossSite;

  const expected = configuredToken();
  if (expected === null) {
    if (isLoopback(request)) return null;
    return Response.json(
      {
        error:
          "Phone management is locked. Set AGENTPHONE_ADMIN_TOKEN on this deployment, then enter it here to provision, release, or change the key.",
        authRequired: true,
      },
      { status: 503 },
    );
  }

  const provided = request.headers.get(PHONE_ADMIN_HEADER);
  if (provided === null || provided.length === 0 || !tokensMatch(expected, provided)) {
    return Response.json(
      { error: "That admin token is not correct.", authRequired: true },
      { status: 401 },
    );
  }
  return null;
}

/** What the panel needs to know before it offers any of the controls. */
export function phoneAuthState(request: Request): {
  authRequired: boolean;
  authConfigured: boolean;
} {
  return {
    // Loopback dev needs no token; everyone else does.
    authRequired: !isLoopback(request) || phoneAdminConfigured(),
    authConfigured: phoneAdminConfigured(),
  };
}
