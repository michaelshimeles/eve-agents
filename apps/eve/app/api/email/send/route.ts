import {
  HANDLED_LABEL,
  UNREAD_LABEL,
  emailConfigured,
  replyToMessage,
  sendMessage,
  updateThreadLabels,
} from "@/agent/lib/agentmail";
import { emailFailure } from "@/lib/email-api";
import { requireWebAuth } from "@/lib/web-auth";

// Sending from the email client page: a new message, or a reply that stays in
// its thread. Same AgentMail inbox as the agent's send_email / reply_to_email
// tools, so a reply typed here and one the agent sends are indistinguishable to
// the recipient. The client mints one clientSendId per draft and keeps it
// across retries of that draft, so a resubmit after an ambiguous failure
// returns the original result instead of mailing a second copy.

export async function POST(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  if (!(await emailConfigured())) return new Response("Email is not configured", { status: 503 });

  const body = (await request.json().catch(() => null)) as {
    replyToMessageId?: unknown;
    replyAll?: unknown;
    to?: unknown;
    cc?: unknown;
    bcc?: unknown;
    subject?: unknown;
    text?: unknown;
    clientSendId?: unknown;
  } | null;
  if (body === null) return new Response("Invalid body", { status: 400 });

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0) return new Response("Message body is required", { status: 400 });
  const idempotencyKey =
    typeof body.clientSendId === "string" && body.clientSendId.trim().length > 0
      ? `web-${body.clientSendId.trim().slice(0, 80)}`
      : undefined;

  try {
    if (typeof body.replyToMessageId === "string" && body.replyToMessageId.length > 0) {
      const result = await replyToMessage(
        body.replyToMessageId,
        {
          text,
          cc: addresses(body.cc),
          replyAll: body.replyAll === true,
        },
        { idempotencyKey },
      );
      // Answering settles the thread, exactly as reply_to_email does.
      await updateThreadLabels(result.thread_id, {
        add: [HANDLED_LABEL],
        remove: [UNREAD_LABEL],
      }).catch(() => undefined);
      return Response.json({ threadId: result.thread_id, messageId: result.message_id });
    }

    const to = addresses(body.to);
    if (to.length === 0) return new Response("At least one recipient is required", { status: 400 });
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    if (subject.length === 0) return new Response("Subject is required", { status: 400 });

    const result = await sendMessage(
      {
        to,
        cc: addresses(body.cc),
        bcc: addresses(body.bcc),
        subject,
        text,
      },
      { idempotencyKey },
    );
    return Response.json({ threadId: result.thread_id, messageId: result.message_id });
  } catch (error) {
    return emailFailure(error);
  }
}

/** Accepts an array or a comma/semicolon-separated string of addresses. */
function addresses(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(/[,;]/)
      : [];
  return raw
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.includes("@"))
    .slice(0, 25);
}
