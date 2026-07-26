import {
  deleteThread,
  getThreadChat,
  upsertThread,
  upsertThreadMeta,
  type ThreadOrigin,
} from "@/lib/threads-db";
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
    pinned?: unknown;
    renamed?: unknown;
    origin?: unknown;
    chat?: unknown;
  } | null;
  if (body === null || typeof body.title !== "string" || typeof body.updatedAt !== "number") {
    return new Response("Invalid body", { status: 400 });
  }
  const meta = {
    title: body.title,
    updatedAt: body.updatedAt,
    pinned: body.pinned === true,
    renamed: body.renamed === true,
    // Origin only matters on first insert; existing rows keep theirs.
    origin: (body.origin === "reminder" || body.origin === "webhook" || body.origin === "email"
      ? body.origin
      : "web") as ThreadOrigin,
  };
  // Meta-only updates (rename, pin) omit the chat payload to leave it intact.
  if (typeof body.chat === "object" && body.chat !== null) {
    await upsertThread(id, meta, body.chat);
  } else {
    await upsertThreadMeta(id, meta);
  }
  return Response.json({ ok: true });
}

export async function DELETE(request: Request, ctx: RouteContext): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  await deleteThread(id);
  return Response.json({ ok: true });
}
