import { templateInfo } from "@/lib/assemble";

// Public, unauthenticated: identity of the agent template bundled into this
// builder deployment. Deployed agents call this to detect updates; they use
// `release` (monotonic, checked into apps/eve) so a content rollback can't
// look like an upgrade, and `version` (content hash) for display.

export async function GET(): Promise<Response> {
  const info = await templateInfo();
  // No CORS headers: only agents' server-side /api/update-check calls this
  // (same-origin browser → agent → builder). Version/release aren't secrets,
  // but wildcard CORS isn't needed for that hop.
  return Response.json(
    { version: info.version, release: info.release },
    {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    },
  );
}
