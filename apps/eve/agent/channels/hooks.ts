import { timingSafeEqual } from "node:crypto";

import { defineChannel, POST } from "eve/channels";

import { ownerName } from "../lib/owner";
import { recordAutomationRun } from "../lib/runs-db";
import { deliverToWebChatThread } from "../lib/web-thread-delivery";
import { getWebhook, recordWebhookFire, type WebhookRow } from "../lib/webhooks-db";
import telegram from "./telegram";

// Event triggers: inbound webhooks that wake the agent when something happens
// (a deploy fails, a form is submitted, an email rule fires). Endpoints are
// minted from chat with the create_webhook tool; rows live in Neon
// (lib/webhooks-db.ts). Mounted at POST /eve/v1/hooks/:hookId/:secret - the
// secret rides in the path because most services can only be given a bare URL.

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
            if (hook.chat_id !== null) {
              await receive(telegram, {
                message,
                target: { chatId: hook.chat_id },
                auth: {
                  authenticator: "webhook",
                  principalType: "service",
                  principalId: `webhook:${hook.id}`,
                  attributes: { webhook_id: hook.id, webhook_name: hook.name },
                },
              });
            } else {
              threadId = await deliverToWebChatThread(`Webhook: ${hook.name}`, message, "webhook");
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
