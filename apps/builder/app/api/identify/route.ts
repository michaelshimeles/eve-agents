import { identify, VercelApiError } from "@/lib/vercel-api";

// Step 1 of the wizard: validate the pasted token and list the scopes
// (personal account + teams) it can deploy into. The token is used for this
// one call and returned nowhere; the client keeps it in memory.

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  if (body === null || typeof body.token !== "string" || body.token.trim().length === 0) {
    return Response.json({ error: "Missing token" }, { status: 400 });
  }
  try {
    const identity = await identify(body.token.trim());
    return Response.json(identity);
  } catch (error) {
    if (error instanceof VercelApiError) {
      const message =
        error.status === 403 || error.status === 401
          ? "Vercel rejected that token. Create one at vercel.com/account/settings/tokens."
          : error.message;
      return Response.json({ error: message }, { status: 400 });
    }
    console.error("identify failed:", error);
    return Response.json({ error: "Could not reach the Vercel API" }, { status: 502 });
  }
}
