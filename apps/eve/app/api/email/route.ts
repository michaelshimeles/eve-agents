import {
  UNREAD_LABEL,
  emailConfigured,
  getInbox,
  listThreads,
  parseAddress,
  searchMessages,
  sentThreadItems,
} from "@/agent/lib/agentmail";
import {
  emailAccount,
  emailFailure,
  summarizeThread,
  toFolder,
  unreadThreadCount,
  type EmailThreadSummary,
} from "@/lib/email-api";
import { requireWebAuth } from "@/lib/web-auth";

// Mailbox listing for the email client page. Reads the same AgentMail inbox the
// agent's tools use, so the page and the agent never disagree about what mail
// exists. Threads carry no direction flag, so Inbox and Sent are separated by
// which timestamps a thread has.

export async function GET(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;

  // No credential is a normal state, not an error: the page explains how to
  // give the agent an address instead of rendering a failure.
  if (!(await emailConfigured())) {
    return Response.json({ configured: false, threads: [], unreadCount: 0 });
  }

  const url = new URL(request.url);
  const folder = toFolder(url.searchParams.get("folder"));
  const query = url.searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 100);

  try {
    const inbox = await getInbox();
    const ownAddress = inbox.email ?? inbox.inbox_id;
    const [account, unreadCount] = await Promise.all([emailAccount(), unreadThreadCount()]);

    // Search spans the whole mailbox and ranks by relevance, so it replaces the
    // folder listing rather than filtering it.
    if (query.length > 0) {
      const matches = await searchMessages(query, { limit });
      const threads: EmailThreadSummary[] = [];
      const seen = new Set<string>();
      for (const message of matches) {
        if (seen.has(message.thread_id)) continue;
        seen.add(message.thread_id);
        threads.push({
          threadId: message.thread_id,
          subject: message.subject ?? "",
          correspondents: [parseAddress(message.from)],
          preview: message.preview ?? "",
          messageCount: 1,
          timestamp: message.timestamp,
          unread: message.labels.includes(UNREAD_LABEL),
          labels: message.labels,
          attachmentCount: (message.attachments ?? []).length,
        });
      }
      return Response.json({ configured: true, account, folder, query, threads, unreadCount });
    }

    // Folder quirks learned against the live API: the thread index omits
    // conversations the agent alone has written to, so Sent comes from
    // sent-labelled messages instead; and trashed threads carry the "trash"
    // label but the server's label filter will not match it, so Trash lists
    // with include_trash and narrows here.
    if (folder === "sent") {
      const sent = await sentThreadItems(limit);
      return Response.json({
        configured: true,
        account,
        folder,
        query: "",
        threads: sent.map((thread) => summarizeThread(thread, ownAddress, folder)),
        unreadCount,
      });
    }

    const page = await listThreads({
      limit: folder === "all" ? limit : Math.min(100, limit * 2),
      labels: folder === "unread" ? [UNREAD_LABEL] : undefined,
      includeTrash: folder === "trash",
    });
    let rows = page.threads.filter((thread) => {
      if (folder === "trash") return thread.labels.includes("trash");
      if (folder === "inbox") return thread.received_timestamp !== undefined;
      return true;
    });
    if (folder === "all") {
      // Fold in the sent-only conversations the index leaves out.
      const known = new Set(rows.map((thread) => thread.thread_id));
      const extras = (await sentThreadItems(limit)).filter(
        (thread) => !known.has(thread.thread_id),
      );
      rows = [...rows, ...extras].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    const threads = rows
      .slice(0, limit)
      .map((thread) => summarizeThread(thread, ownAddress, folder));

    return Response.json({ configured: true, account, folder, query: "", threads, unreadCount });
  } catch (error) {
    return emailFailure(error);
  }
}
