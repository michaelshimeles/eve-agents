import { timingSafeEqual } from "node:crypto";

import { defineChannel, POST } from "eve/channels";

import { resolveDeliveryRoute } from "../lib/delivery";
import { notifyOwnerOverIMessage } from "../lib/effect/imessage";
import { runTool } from "../lib/effect/runtime";
import { ownerName } from "../lib/owner";
import { recordAutomationRun } from "../lib/runs-db";
import { deliverToWebChatThread } from "../lib/web-thread-delivery";
import { getWebhook, recordWebhookFire, type WebhookRow } from "../lib/webhooks-db";
import agentphone from "./agentphone";
import imessage from "./imessage";
import slack from "./slack";
import telegram from "./telegram";

// Event triggers: inbound webhooks that wake the agent when something happens
// (a deploy fails, a form is submitted, an email rule fires). Endpoints are
// minted from chat with the create_webhook tool; rows live in Neon
// (lib/webhooks-db.ts). Mounted at POST /eve/v1/hooks/:hookId/:secret - the
// secret rides in the path because most services can only be given a bare URL.
// Results deliver per the owner's preference (lib/delivery.ts), same as
// reminders: where the hook was created by default, or one pinned place.

const MAX_PAYLOAD_CHARS = 6000;

function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readPayload(req: Request): Promise<string> {
  const raw = (await req.text().catch(() => "")).trim();
  if (raw.length === 0) return "(empty body)";
  const clipped = raw.length > MAX_PAYLOAD_CHARS ? `${raw.slice(0, MAX_PAYLOAD_CHARS)}\n… (payload truncated)` : raw;
  try {
    return JSON.stringify(JSON.parse(clipped), null, 2);
  } catch {
    return clipped;
  }
}

function hookMessage(hook: WebhookRow, contentType: string | null, payload: string): string {
  return [
    `Your webhook "${hook.name}" (id ${hook.id}) just received an event. Your stored instruction for it:`,
    "",
    hook.prompt,
    "",
    `Payload${contentType !== null ? ` (${contentType})` : ""}:`,
    "```",
    payload,
    "```",
    "",
    `Carry out the instruction now and send ${ownerName()} the result. They didn't just message you - this fired on its own, so lead with what this is about.`,
  ].join("\n");
}

export default defineChannel({
  routes: [
    POST("/eve/v1/hooks/:hookId/:secret", async (req, { receive, waitUntil, params }) => {
      const hook = await getWebhook(params.hookId);
      // A single 404 for both unknown id and bad secret, so probing reveals nothing.
      if (hook === null || !secretsMatch(hook.secret, params.secret)) {
        return new Response("Not found", { status: 404 });
      }

      const payload = await readPayload(req);
      const message = hookMessage(hook, req.headers.get("content-type"), payload);

      await recordWebhookFire(hook.id);
      waitUntil(
        (async () => {
          try {
            let threadId: string | undefined;
            const route = await resolveDeliveryRoute(hook.chat_id);
            const auth = {
              authenticator: "webhook",
              principalType: "service" as const,
              principalId: `webhook:${hook.id}`,
              attributes: { webhook_id: hook.id, webhook_name: hook.name },
            };
            if (route.kind === "telegram") {
              await receive(telegram, {
                message,
                target: { chatId: route.chatId },
                auth,
              });
            } else if (route.kind === "imessage") {
              // The session runs in the owner's iMessage conversation, so a
              // reply text continues it.
              await receive(imessage, {
                message,
                target: { handle: route.handle },
                auth,
              });
            } else if (route.kind === "slack") {
              // The session runs in the owner's Slack DM, so a reply in that
              // thread continues it.
              await receive(slack, {
                message,
                target: { channelId: route.channelId },
                auth,
              });
            } else if (route.kind === "phone") {
              // The session runs in the owner's text thread, so a reply
              // continues it.
              await receive(agentphone, {
                message,
                target: { target: route.target },
                auth,
              });
            } else {
              const delivery = await deliverToWebChatThread(`Webhook: ${hook.name}`, message, "webhook");
              threadId = delivery.threadId;
              // Best-effort, like the web push: the thread is already
              // persisted, so an iMessage failure must not fail the delivery
              // — the sender would retry and create a duplicate thread.
              if (route.mirror) {
                try {
                  await runTool(
                    notifyOwnerOverIMessage(delivery.reply ?? `Webhook "${hook.name}" fired.`),
                  );
                } catch (error) {
                  console.error(`Webhook ${hook.id} iMessage notification failed.`, error);
                }
              }
            }
            await recordAutomationRun({
              kind: "webhook",
              automationId: hook.id,
              status: "ok",
              threadId,
            });
          } catch (error) {
            console.error(`Webhook ${hook.id} processing failed.`, error);
            await recordAutomationRun({
              kind: "webhook",
              automationId: hook.id,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            }).catch(() => undefined);
          }
        })(),
      );

      // Ack immediately; senders retry on non-2xx and the work runs on.
      return Response.json({ ok: true });
    }),
  ],
});
