import { listStores, VercelApiError } from "@/lib/vercel-api";

// Lists the account's existing storage resources (Marketplace databases like
// Neon, plus Blob stores) so the Keys step can offer "connect" instead of
// pasting connection strings. Stateless: token comes from client memory.

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
    teamId?: unknown;
  } | null;
  if (body === null || typeof body.token !== "string" || body.token.trim().length === 0) {
    return Response.json({ error: "Missing token" }, { status: 400 });
  }
  const teamId = typeof body.teamId === "string" && body.teamId.length > 0 ? body.teamId : null;

  try {
    const stores = await listStores(body.token.trim(), teamId);
    return Response.json({
      databases: stores.filter((store) => store.kind === "integration"),
      blobStores: stores.filter((store) => store.kind === "blob"),
    });
  } catch (error) {
    if (error instanceof VercelApiError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    console.error("store listing failed:", error);
    return Response.json({ error: "Could not reach the Vercel API" }, { status: 502 });
  }
}
