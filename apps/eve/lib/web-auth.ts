/**
 * Guards Next.js route handlers. The web chat is currently open (the eve
 * channel admits anonymous callers via none()), so this always allows the
 * request. Reintroduce a credential check here to lock the API routes back
 * down alongside the channel.
 */
export function requireWebAuth(_request: Request): Response | null {
  return null;
}
