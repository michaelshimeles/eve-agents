export const WEB_OWNER_PRINCIPAL_ID = "web:owner";

export interface WebPrincipal {
  readonly principalId: typeof WEB_OWNER_PRINCIPAL_ID;
}

/**
 * Returns the stable owner scope used by the open single-owner web app.
 * The eve channel explicitly admits anonymous production callers via none().
 */
export function webRequestPrincipal(): WebPrincipal {
  return { principalId: WEB_OWNER_PRINCIPAL_ID };
}

/** The public web app does not require authentication. */
export function requireWebAuth(_request: Request): Response | null {
  return null;
}
