export type EveHeadersResolver = () => Promise<Readonly<Record<string, string>>>;

type ClerkTokenGetter = () => Promise<string | null>;

/**
 * Resolve a fresh Clerk session token before every Eve request. Clerk session
 * cookies contain short-lived JWTs; the separate Eve service cannot refresh an
 * expired cookie on a POST, while Clerk's browser client can mint a current
 * bearer without interrupting the signed-in session.
 */
export function createEveClerkHeaders(getToken: ClerkTokenGetter): EveHeadersResolver {
  return async () => {
    const token = await getToken();
    if (token === null) {
      throw new Error("Your sign-in session is no longer available. Refresh and sign in again.");
    }
    return { authorization: `Bearer ${token}` };
  };
}
