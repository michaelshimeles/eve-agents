import { deleteThread, getThreadChat, upsertThread } from "@/lib/threads-db";
import { requireWebAuth } from "@/lib/web-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const chat = await getThreadChat(id);
  if (chat === null) return new Response("Not found", { status: 404 });
  return Response.json({ chat });
}

export async function PUT(request: Request, ctx: RouteContext): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    updatedAt?: unknown;
    chat?: unknown;
  } | null;
  if (
    body === null ||
    typeof body.title !== "string" ||
    typeof body.updatedAt !== "number" ||
    typeof body.chat !== "object" ||
    body.chat === null
  ) {
    return new Response("Invalid body", { status: 400 });
  }
  await upsertThread(id, body.title, body.updatedAt, body.chat);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request, ctx: RouteContext): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  await deleteThread(id);
  return Response.json({ ok: true });
}
