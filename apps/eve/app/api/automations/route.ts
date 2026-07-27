import {
  deliveryView,
  isDeliveryTarget,
  setDeliveryTarget,
  type DeliveryView,
} from "@/agent/lib/delivery";
import { cancelReminder, listReminders } from "@/agent/lib/reminders-db";
import { listRecentRuns } from "@/agent/lib/runs-db";
import { deleteWebhook, listWebhooks, webhookUrl } from "@/agent/lib/webhooks-db";
import { requireWebAuth } from "@/lib/web-auth";

// Management surface for the web UI: what Ruth has scheduled (reminders), what
// can wake her (webhooks), what happened when they fired (runs), and where
// results get delivered (PUT), with delete. Mirrors the chat tools
// (list_reminders, cancel_reminder, list_webhooks, delete_webhook) so the
// panel and the agent always agree.

const DELIVERY_FALLBACK: DeliveryView = {
  target: "origin",
  telegramLinked: false,
  imessagePaired: false,
};

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const [reminders, webhooks, runs, delivery] = await Promise.all([
    listReminders(),
    listWebhooks(),
    listRecentRuns().catch(() => []),
    deliveryView().catch(() => DELIVERY_FALLBACK),
  ]);
  return Response.json({
    delivery,
    reminders: reminders.map((reminder) => ({
      id: reminder.id,
      prompt: reminder.prompt,
      cron: reminder.cron,
      timezone: reminder.timezone,
      nextFireAt: reminder.next_fire_at,
      lastFiredAt: reminder.last_fired_at,
    })),
    webhooks: webhooks.map((hook) => ({
      id: hook.id,
      name: hook.name,
      prompt: hook.prompt,
      url: webhookUrl(hook),
      fireCount: hook.fire_count,
      lastFiredAt: hook.last_fired_at,
    })),
    runs: runs.map((run) => ({
      id: run.id,
      kind: run.kind,
      automationId: run.automation_id,
      firedAt: run.fired_at,
      status: run.status,
      error: run.error,
      threadId: run.thread_id,
    })),
  });
}

/** Save the delivery preference for reminder and trigger results. */
export async function PUT(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { delivery?: unknown } | null;
  if (body === null || !isDeliveryTarget(body.delivery)) {
    return new Response("Invalid body", { status: 400 });
  }
  try {
    await setDeliveryTarget(body.delivery);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save the preference." },
      { status: 400 },
    );
  }
  return Response.json({ ok: true, delivery: await deliveryView().catch(() => DELIVERY_FALLBACK) });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as
    | { kind?: unknown; id?: unknown }
    | null;
  if (body === null) return new Response("Invalid body", { status: 400 });

  if (body.kind === "reminder" && typeof body.id === "number") {
    const cancelled = await cancelReminder(body.id);
    if (cancelled === null) return new Response("Not found", { status: 404 });
    return Response.json({ ok: true });
  }
  if (body.kind === "webhook" && typeof body.id === "string") {
    const deleted = await deleteWebhook(body.id);
    if (deleted === null) return new Response("Not found", { status: 404 });
    return Response.json({ ok: true });
  }
  return new Response("Invalid body", { status: 400 });
}
