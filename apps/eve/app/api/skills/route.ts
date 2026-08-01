import { skillStore } from "@/agent/lib/skill-store";
import { requireWebAuth } from "@/lib/web-auth";

// Skills manager backing: full read/edit/delete of chat-created skills.
// Mirrors the agent's create_skill/delete_skill tools so the panel and the
// slash palette stay in sync with what the agent can actually run.

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export async function GET(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  try {
    const skills = await skillStore.list();
    return Response.json({ skills });
  } catch {
    return Response.json({ skills: [] });
  }
}

export async function PUT(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    description?: unknown;
    markdown?: unknown;
  } | null;
  if (
    body === null ||
    typeof body.name !== "string" ||
    !NAME_PATTERN.test(body.name) ||
    body.name.length > 50 ||
    typeof body.description !== "string" ||
    body.description.length === 0 ||
    body.description.length > 300 ||
    typeof body.markdown !== "string" ||
    body.markdown.length === 0 ||
    body.markdown.length > 8000
  ) {
    return new Response("Invalid body", { status: 400 });
  }
  const stored = await skillStore.put({
    name: body.name,
    description: body.description,
    markdown: body.markdown,
  });
  return Response.json({ skill: stored });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  if (body === null || typeof body.name !== "string" || body.name.length === 0) {
    return new Response("Invalid body", { status: 400 });
  }
  const deleted = await skillStore.delete(body.name);
  if (!deleted) return new Response("Not found", { status: 404 });
  return Response.json({ ok: true });
}
