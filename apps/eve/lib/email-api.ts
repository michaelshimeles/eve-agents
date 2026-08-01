import {
  AgentMailError,
  UNREAD_LABEL,
  getInbox,
  listThreads,
  messageBody,
  parseAddress,
  type Message,
  type ThreadItem,
} from "@/agent/lib/agentmail";
import { getWebhookRegistration } from "@/agent/lib/email-db";
import { INBOUND_WEBHOOK_CLIENT_ID, inboundWebhookUrl } from "@/agent/lib/email-inbound";

// Shared shapes and projections for the email client page. The API routes under
// app/api/email/** speak these, and components/email-client.tsx renders them, so
// the wire format lives in one place. The underlying account is the same
// AgentMail inbox the agent's tools use.

export type EmailFolder = "inbox" | "unread" | "sent" | "all" | "trash";

export const EMAIL_FOLDERS: readonly EmailFolder[] = ["inbox", "unread", "sent", "all", "trash"];

export interface EmailAddress {
  name: string | null;
  address: string;
}

export interface EmailAccount {
  emailAddress: string;
  displayName: string | null;
  /** True once AgentMail is delivering new mail straight to this deployment. */
  inboundReady: boolean;
}

export interface EmailThreadSummary {
  threadId: string;
  subject: string;
  /** The other party in the conversation, for the list column. */
  correspondents: EmailAddress[];
  preview: string;
  messageCount: number;
  timestamp: string;
  unread: boolean;
  labels: string[];
  attachmentCount: number;
}

export interface EmailAttachmentView {
  attachmentId: string;
  filename: string;
  contentType: string | null;
  size: number;
}

export interface EmailMessageView {
  messageId: string;
  direction: "sent" | "received";
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  timestamp: string;
  text: string;
  /** Sanitized HTML body, when the message had one worth rendering. */
  html: string | null;
  attachments: EmailAttachmentView[];
  labels: string[];
}

export interface EmailThreadView {
  threadId: string;
  subject: string;
  labels: string[];
  lastMessageId: string;
  messages: EmailMessageView[];
}

export interface EmailListResponse {
  configured: boolean;
  account?: EmailAccount;
  folder?: EmailFolder;
  query?: string;
  threads: EmailThreadSummary[];
  unreadCount: number;
}

export function toFolder(raw: string | null): EmailFolder {
  return EMAIL_FOLDERS.includes(raw as EmailFolder) ? (raw as EmailFolder) : "inbox";
}

export function summarizeThread(
  thread: ThreadItem,
  ownAddress: string,
  folder: EmailFolder,
): EmailThreadSummary {
  // In Sent the interesting party is who we wrote to; everywhere else it is
  // who wrote in. When dropping the agent's own address empties the list (a
  // sent-only conversation surfacing in All), the other side of the exchange
  // is the one worth showing before falling back to the raw list.
  const source = folder === "sent" ? thread.recipients : thread.senders;
  const alternate = folder === "sent" ? thread.senders : thread.recipients;
  const parsed = source.map(parseAddress);
  let others = parsed.filter((entry) => !sameAddress(entry.address, ownAddress));
  if (others.length === 0) {
    others = alternate.map(parseAddress).filter((entry) => !sameAddress(entry.address, ownAddress));
  }
  return {
    threadId: thread.thread_id,
    subject: thread.subject ?? "",
    correspondents: (others.length > 0 ? others : parsed).slice(0, 3),
    preview: thread.preview ?? "",
    messageCount: thread.message_count,
    timestamp: thread.timestamp,
    unread: thread.labels.includes(UNREAD_LABEL),
    labels: thread.labels,
    attachmentCount: (thread.attachments ?? []).length,
  };
}

export function projectMessage(message: Message, ownAddress: string): EmailMessageView {
  const from = parseAddress(message.from);
  const rawHtml = message.html ?? message.extracted_html ?? null;
  // Sanitize before deciding whether an HTML body exists: mail that is nothing
  // but trackers sanitizes to "", and the pane should fall back to text rather
  // than render a blank frame.
  const html = rawHtml !== null ? sanitizeHtml(rawHtml) : "";
  return {
    messageId: message.message_id,
    direction: sameAddress(from.address, ownAddress) ? "sent" : "received",
    from,
    to: (message.to ?? []).map(parseAddress),
    cc: (message.cc ?? []).map(parseAddress),
    subject: message.subject ?? "",
    timestamp: message.timestamp,
    text: messageBody(message),
    html: html.trim().length > 0 ? html : null,
    attachments: (message.attachments ?? []).map((attachment) => ({
      attachmentId: attachment.attachment_id,
      filename: attachment.filename ?? "attachment",
      contentType: attachment.content_type ?? null,
      size: attachment.size,
    })),
    labels: message.labels,
  };
}

export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function emailAccount(): Promise<EmailAccount> {
  const inbox = await getInbox();
  // Inbound is "ready" once AgentMail has been pointed at this deployment. The
  // email schedule registers that; until it has, the same schedule polls.
  let inboundReady = false;
  try {
    const registration = await getWebhookRegistration(INBOUND_WEBHOOK_CLIENT_ID);
    inboundReady = registration !== null && registration.url === inboundWebhookUrl();
  } catch {
    inboundReady = false;
  }
  return {
    emailAddress: inbox.email ?? inbox.inbox_id,
    displayName: inbox.display_name ?? null,
    inboundReady,
  };
}

export async function unreadThreadCount(): Promise<number> {
  try {
    const unread = await listThreads({ labels: [UNREAD_LABEL], limit: 100 });
    return unread.count;
  } catch {
    return 0;
  }
}

/** Passes AgentMail's own message through so the page can show what to fix. */
export function emailFailure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof AgentMailError ? error.status : 502;
  console.error("Email request failed.", error);
  return Response.json(
    { error: message },
    { status: status >= 400 && status < 600 ? status : 502 },
  );
}

/**
 * Strips anything active out of an email's HTML before it reaches the reading
 * pane. Inbound mail is attacker-controlled, and the pane renders it inline, so
 * scripts, embedded frames, event handlers, and remote CSS all have to go.
 * Remote loads are dropped too - img tags, style url(...) values, and legacy
 * background attributes are all read receipts in disguise. The reading pane's
 * iframe additionally carries a no-network CSP, so anything a regex misses
 * still cannot phone home from there.
 */
export function sanitizeHtml(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|link|meta|base|form|input|button)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|link|meta|base|form|input|button)\b[^>]*\/?>/gi, "")
    // Inline handlers (onclick=…) and javascript: URLs.
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|src|action)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, "")
    // Tracking pixels and their attribute-based cousins.
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\s(?:background|srcset|poster|lowsrc|dynsrc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // Inline styles that reach out over the network (url(...)) or run code.
    .replace(/\sstyle\s*=\s*(?:"[^"]*(?:url\s*\(|expression)[^"]*"|'[^']*(?:url\s*\(|expression)[^']*')/gi, "");
  // A body that was nothing but scripts and images is better shown as text.
  return stripped.replace(/<[^>]+>/g, "").trim().length === 0 ? "" : stripped;
}

