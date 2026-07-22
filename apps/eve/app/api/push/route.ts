import { deleteSubscription, saveSubscription } from "@/lib/push-db";
import { requireWebAuth } from "@/lib/web-auth";

export async function POST(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (body === null || typeof body.endpoint !== "string") {
    return new Response("Invalid subscription", { status: 400 });
  }
  await saveSubscription(body as Parameters<typeof saveSubscription>[0]);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (body === null || typeof body.endpoint !== "string") {
    return new Response("Invalid body", { status: 400 });
  }
  await deleteSubscription(body.endpoint);
  return Response.json({ ok: true });
}
