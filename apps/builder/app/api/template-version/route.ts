import { templateInfo } from "@/lib/assemble";

// Public, unauthenticated: identity of the agent template bundled into this
// builder deployment. Deployed agents call this to detect updates; they use
// `release` (monotonic, checked into apps/eve) so a content rollback can't
// look like an upgrade, and `version` (content hash) for display.

export async function GET(): Promise<Response> {
  const info = await templateInfo();
  return Response.json(
    { version: info.version, release: info.release },
    {
      headers: {
        // Deployed agents fetch this cross-origin from their own server and
        // occasionally from the browser; the version is not a secret.
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    },
  );
}
