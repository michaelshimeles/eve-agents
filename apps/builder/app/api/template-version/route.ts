import { templateInfo } from "@/lib/assemble";

// Public, unauthenticated: identity of the agent template bundled into this
// builder deployment. Deployed agents call this to detect updates; they use
// `version` for equality and `publishedAt` so a builder rollback isn't
// offered as an upgrade.

export async function GET(): Promise<Response> {
  const info = await templateInfo();
  return Response.json(
    { version: info.version, publishedAt: info.publishedAt },
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
