import { getDeploymentStatus, VercelApiError } from "@/lib/vercel-api";

// Polled by the wizard while the remote build runs. Stateless: the client
// resends the token each time (it holds it in memory), so the builder never
// stores anything.

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
    teamId?: unknown;
    deploymentId?: unknown;
  } | null;
  if (
    body === null ||
    typeof body.token !== "string" ||
    typeof body.deploymentId !== "string" ||
    body.token.length === 0 ||
    body.deploymentId.length === 0
  ) {
    return Response.json({ error: "Missing token or deploymentId" }, { status: 400 });
  }
  const teamId = typeof body.teamId === "string" && body.teamId.length > 0 ? body.teamId : null;

  try {
    const status = await getDeploymentStatus(body.token, teamId, body.deploymentId);
    return Response.json(status);
  } catch (error) {
    if (error instanceof VercelApiError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    console.error("status poll failed:", error);
    return Response.json({ error: "Could not reach the Vercel API" }, { status: 502 });
  }
}
