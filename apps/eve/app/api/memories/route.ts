import { memoryStore } from "@/agent/lib/memory-store";
import { requireWebAuth } from "@/lib/web-auth";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const memories = await memoryStore.list();
  return Response.json({ memories });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  if (body === null || typeof body.id !== "string" || body.id.length === 0) {
    return new Response("Invalid body", { status: 400 });
  }
  const forgotten = await memoryStore.delete(body.id);
  if (!forgotten) return new Response("Not found", { status: 404 });
  return Response.json({ ok: true });
}
