import {
  HANDLED_LABEL,
  UNREAD_LABEL,
  emailConfigured,
  getInbox,
  getThread,
  updateThreadLabels,
} from "@/agent/lib/agentmail";
import { emailFailure, projectMessage, type EmailThreadView } from "@/lib/email-api";
import { requireWebAuth } from "@/lib/web-auth";

// One conversation for the reading pane, plus the label writes the pane needs:
// mark read/unread, trash, restore. Labels are how AgentMail stores mailbox
// state, so this is the same surface the agent's label_email tool uses.

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  if (!(await emailConfigured())) return new Response("Email is not configured", { status: 503 });

  const { id } = await ctx.params;
  const markRead = new URL(request.url).searchParams.get("markRead") !== "false";

  try {
    const inbox = await getInbox();
    const thread = await getThread(id);
    const ownAddress = inbox.email ?? inbox.inbox_id;

    // Opening a thread in the client is reading it, same as in any mail app.
    if (markRead && thread.labels.includes(UNREAD_LABEL)) {
      await updateThreadLabels(id, { add: [HANDLED_LABEL], remove: [UNREAD_LABEL] }).catch(
        (error: unknown) => {
          console.error(`Marking email thread ${id} read failed.`, error);
        },
      );
    }

    const view: EmailThreadView = {
      threadId: thread.thread_id,
      subject: thread.subject ?? "",
      labels: markRead ? thread.labels.filter((label) => label !== UNREAD_LABEL) : thread.labels,
      lastMessageId: thread.last_message_id,
      messages: thread.messages.map((message) => projectMessage(message, ownAddress)),
    };
    return Response.json({ thread: view });
  } catch (error) {
    return emailFailure(error);
  }
}

export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  if (!(await emailConfigured())) return new Response("Email is not configured", { status: 503 });

  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as {
    add?: unknown;
    remove?: unknown;
  } | null;
  const add = labelList(body?.add);
  const remove = labelList(body?.remove);
  if (add.length === 0 && remove.length === 0) {
    return new Response("Pass labels to add or remove", { status: 400 });
  }

  try {
    await updateThreadLabels(id, { add, remove });
    return Response.json({ ok: true });
  } catch (error) {
    return emailFailure(error);
  }
}

function labelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 60)
    .slice(0, 10);
}
