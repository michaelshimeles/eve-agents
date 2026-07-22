import { CANDIDATE_TOOLKITS, manageConnections } from "@/lib/composio-connect";
import { requireWebAuth } from "@/lib/web-auth";

// Connections manager: which Composio apps are linked, plus connect (returns
// an OAuth link to open) and disconnect. Uses the same Composio Connect MCP
// the agent uses, so the panel reflects exactly what Eve can reach.

interface ToolkitResult {
  toolkit?: string;
  status?: string;
  accounts?: {
    id?: string;
    status?: string;
    alias?: string;
    is_default?: boolean;
    user_info?: Record<string, unknown>;
  }[];
  redirect_url?: string;
  error_message?: string;
}

/** Pick a human-readable account label out of Composio's loose user_info. */
function accountLabel(info: Record<string, unknown> | undefined): string | null {
  if (!info) return null;
  for (const key of ["emailAddress", "email", "login", "username", "name", "id"]) {
    const value = info[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  try {
    const data = await manageConnections(
      CANDIDATE_TOOLKITS.map((name) => ({ name, action: "list" as const })),
    );
    const results = (data.results ?? {}) as Record<string, ToolkitResult>;
    const connections = Object.values(results)
      .filter((entry) => (entry.accounts?.length ?? 0) > 0)
      .map((entry) => ({
        toolkit: entry.toolkit ?? "",
        accounts: (entry.accounts ?? []).map((account) => ({
          id: account.id ?? "",
          status: account.status ?? "unknown",
          alias: account.alias ?? null,
          label: accountLabel(account.user_info),
        })),
      }));
    return Response.json({ connections, checked: CANDIDATE_TOOLKITS });
  } catch (error) {
    console.error("Connections list failed:", error);
    return new Response("Connections unavailable", { status: 502 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { toolkit?: unknown } | null;
  if (body === null || typeof body.toolkit !== "string" || !/^[a-z0-9_-]+$/.test(body.toolkit)) {
    return new Response("Invalid body", { status: 400 });
  }

  try {
    const data = await manageConnections([{ name: body.toolkit, action: "add" }]);
    const results = (data.results ?? {}) as Record<string, ToolkitResult>;
    const entry = results[body.toolkit];
    if (entry?.redirect_url) return Response.json({ url: entry.redirect_url });
    return new Response(entry?.error_message ?? "No auth link returned", { status: 502 });
  } catch (error) {
    console.error("Connection add failed:", error);
    return new Response(error instanceof Error ? error.message : "Connect failed", {
      status: 502,
    });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as {
    toolkit?: unknown;
    accountId?: unknown;
  } | null;
  if (
    body === null ||
    typeof body.toolkit !== "string" ||
    !/^[a-z0-9_-]+$/.test(body.toolkit) ||
    typeof body.accountId !== "string" ||
    body.accountId.length === 0
  ) {
    return new Response("Invalid body", { status: 400 });
  }

  try {
    await manageConnections([
      { name: body.toolkit, action: "remove", account_id: body.accountId },
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Connection remove failed:", error);
    return new Response("Disconnect failed", { status: 502 });
  }
}
