import { deleteSubscription, parseSubscription, saveSubscription } from "@/lib/push-db";
import { requireWebAuth } from "@/lib/web-auth";

export async function POST(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const subscription = parseSubscription(await request.json().catch(() => null));
  if (subscription === null) {
    return new Response("Invalid subscription", { status: 400 });
  }
  await saveSubscription(subscription);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (body === null || typeof body.endpoint !== "string") {
    return new Response("Invalid body", { status: 400 });
  }
  await deleteSubscription(body.endpoint);
  return Response.json({ ok: true });
}
