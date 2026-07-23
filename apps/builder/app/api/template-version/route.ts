import { templateVersion } from "@/lib/assemble";

// Public, unauthenticated: the version (content hash) of the agent template
// bundled into this builder deployment. Deployed agents call this to detect
// that a newer template is available; the update flow shows it as "latest".

export async function GET(): Promise<Response> {
  const version = await templateVersion();
  return Response.json(
    { version },
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
