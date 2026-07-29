import { createHash, timingSafeEqual } from "node:crypto";

// A self-contained gate for management routes that must not inherit the
// app's open-by-design posture (`lib/web-auth.ts` no-ops). Instantiated per
// surface — phone management (`lib/phone-auth.ts`) and the Agentcard company
// connect (`lib/card-auth.ts`) — so each carries its own env var, header,
// and locked-state message while sharing one set of rules:
//
// It fails CLOSED. With no token configured, a deployment reachable from the
// internet refuses every mutation and says how to enable them. The only
// exception is a loopback request, because `next dev` on your own machine is
// not a threat model and the alternative is being unable to develop.

export interface AdminGate {
  /** Whether this deployment has an admin token at all. */
  readonly configured: () => boolean;
  /**
   * Guards a state-changing request. Returns a `Response` to send when the
   * caller may not proceed, or `null` when they may.
   */
  readonly require: (request: Request) => Response | null;
  /** What the panel needs to know before it offers any of the controls. */
  readonly state: (request: Request) => { authRequired: boolean; authConfigured: boolean };
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

export function adminGate(options: {
  /** Request header carrying the token, e.g. "x-phone-admin-token". */
  readonly header: string;
  /** Env var holding the expected token. */
  readonly envVar: string;
  /** Told to a locked-out caller: what to set, and what that unlocks. */
  readonly lockedMessage: string;
}): AdminGate {
  const configuredToken = (): string | null => {
    const token = process.env[options.envVar]?.trim();
    return token === undefined || token.length === 0 ? null : token;
  };

  const configured = (): boolean => configuredToken() !== null;

  const require = (request: Request): Response | null => {
    const crossSite = rejectCrossSite(request);
    if (crossSite !== null) return crossSite;

    const expected = configuredToken();
    if (expected === null) {
      if (isLoopback(request)) return null;
      return Response.json({ error: options.lockedMessage, authRequired: true }, { status: 503 });
    }

    const provided = request.headers.get(options.header);
    if (provided === null || provided.length === 0 || !tokensMatch(expected, provided)) {
      return Response.json(
        { error: "That admin token is not correct.", authRequired: true },
        { status: 401 },
      );
    }
    return null;
  };

  const state = (request: Request): { authRequired: boolean; authConfigured: boolean } => ({
    // Loopback dev needs no token; everyone else does.
    authRequired: !isLoopback(request) || configured(),
    authConfigured: configured(),
  });

  return { configured, require, state };
}
