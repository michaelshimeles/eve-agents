// The agent's own email account, backed by AgentMail (https://agentmail.to).
// AgentMail's primitive is the inbox: a real address on the internet that
// people and services can write to, with persistent storage and automatic
// threading. Ruth owns one inbox; this module is the only place that talks to
// the API, shared by her tools (agent/tools/email_*.ts), the inbound channel
// (agent/channels/email.ts) and the web email client (app/api/email/**).
//
// Hand-rolled over fetch rather than the SDK, matching lib/memory-store.ts:
// one small typed surface, no extra dependency, and it runs unchanged in the
// agent runtime and in Next.js route handlers.

import { getConnectedDomain } from "./email-db";
import { settingsStore } from "./settings-db";

const DEFAULT_API_BASE = "https://api.agentmail.to";

/** app_settings row under which a UI-entered API key is stored. */
const API_KEY_SETTING = "agentmail-api-key";

/** Stable client id so provisioning is idempotent across restarts and deploys. */
const INBOX_CLIENT_ID = "eve-agent-inbox";

/** Label AgentMail puts on messages the inbox has not processed yet. */
export const UNREAD_LABEL = "unread";

/**
 * Label the agent adds once it has triaged a message, so it is never
 * re-handled. Deliberately not derived from the agent's display name: renaming
 * the agent must not orphan the labels already on its mail.
 */
export const HANDLED_LABEL = "agent-handled";

export class AgentMailError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AgentMailError";
    this.status = status;
  }
}

/** Thrown when the deployment has no AgentMail credential at all. */
export class AgentMailNotConfiguredError extends Error {
  constructor() {
    super(
      "No AgentMail API key is configured (set AGENTMAIL_API_KEY, or paste one on the /email page), so the agent has no email account.",
    );
    this.name = "AgentMailNotConfiguredError";
  }
}

// The credential can come from the deployment environment or be pasted into
// the app itself (stored through settingsStore, which caches reads and treats
// a missing database as "not configured"). The env var wins when both exist,
// so ops always has the last word.
function envApiKey(): string | null {
  const key = process.env.AGENTMAIL_API_KEY?.trim();
  return key !== undefined && key.length > 0 ? key : null;
}

async function storedApiKey(): Promise<string | null> {
  const stored = await settingsStore.get(API_KEY_SETTING);
  return stored !== null && stored.trim().length > 0 ? stored.trim() : null;
}

async function resolveApiKey(): Promise<string | null> {
  return envApiKey() ?? (await storedApiKey());
}

export async function emailConfigured(): Promise<boolean> {
  return (await resolveApiKey()) !== null;
}

/** Which credential the client is using right now, for the key dialog. */
export async function apiKeySource(): Promise<"env" | "app" | "none"> {
  if (envApiKey() !== null) return "env";
  return (await storedApiKey()) !== null ? "app" : "none";
}

/** Last characters of the active key, so the UI can identify without revealing. */
export async function apiKeyHint(): Promise<string | null> {
  const key = await resolveApiKey();
  return key === null ? null : `…${key.slice(-4)}`;
}

/**
 * Validates `key` against AgentMail and stores it as the app's credential.
 * Rejects rather than saves a key AgentMail itself does not accept.
 */
export async function saveApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (trimmed.length < 8) throw new Error("That does not look like an AgentMail API key.");
  const response = await fetch(`${apiBase()}/v0/auth/me`, {
    headers: { Authorization: `Bearer ${trimmed}` },
  });
  if (!response.ok) {
    throw new AgentMailError(
      response.status === 401 || response.status === 403
        ? "AgentMail rejected that API key."
        : `AgentMail could not validate the key (${response.status}).`,
      response.status,
    );
  }
  await settingsStore.set(API_KEY_SETTING, trimmed);
  // A different key can mean a different organization and thus a different
  // inbox, so the resolved identity must not outlive the credential.
  invalidateInboxCache();
}

export async function removeStoredApiKey(): Promise<void> {
  await settingsStore.delete(API_KEY_SETTING);
  invalidateInboxCache();
}

function apiBase(): string {
  const configured = process.env.AGENTMAIL_API_BASE_URL?.trim();
  return (configured !== undefined && configured.length > 0 ? configured : DEFAULT_API_BASE).replace(
    /\/+$/,
    "",
  );
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  /**
   * Makes a send replay-safe: a retry with the same key returns the original
   * result instead of mailing a second copy. Keys expire after 24 hours.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const apiKey = await resolveApiKey();
  if (apiKey === null) throw new AgentMailNotConfiguredError();

  const url = new URL(`${apiBase()}/v0${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue;
    // Repeatable filters (labels, senders, …) are sent as one param per value.
    if (Array.isArray(value)) for (const entry of value) url.searchParams.append(key, entry);
    else url.searchParams.set(key, String(value));
  }

  const method = options.method ?? "GET";
  // AgentMail only accepts [A-Za-z0-9-._~] in Idempotency-Key (an invalid or
  // empty key is a 400, not a silent pass), so map anything else to a dot.
  // Callers pass opaque ids; the mapping is stable, which is all replay
  // protection needs.
  const idempotencyKey = options.idempotencyKey?.trim().replace(/[^A-Za-z0-9\-._~]/g, ".");
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(idempotencyKey !== undefined && idempotencyKey.length > 0
        ? { "Idempotency-Key": idempotencyKey }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new AgentMailError(
      `AgentMail ${method} ${path} failed (${response.status}): ${clip(text)}`,
      response.status,
    );
  }
  return (text.length > 0 ? (JSON.parse(text) as T) : (null as T));
}

function clip(text: string): string {
  const oneLine = text.replaceAll("\n", " ").trim();
  return oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine;
}

// --- API shapes (subset of https://docs.agentmail.to/openapi.json) ---------

export interface Inbox {
  inbox_id: string;
  email?: string;
  display_name?: string;
  client_id?: string;
  created_at: string;
}

export interface Attachment {
  attachment_id: string;
  filename?: string;
  size: number;
  content_type?: string;
  content_disposition?: string;
  content_id?: string;
}

export interface MessageItem {
  inbox_id: string;
  thread_id: string;
  message_id: string;
  labels: string[];
  timestamp: string;
  from: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  preview?: string;
  attachments?: Attachment[];
  updated_at: string;
  created_at: string;
}

export interface Message extends MessageItem {
  text?: string;
  html?: string;
  /** Reply body with the quoted history stripped out. */
  extracted_text?: string;
  extracted_html?: string;
  reply_to?: string[];
  in_reply_to?: string;
}

export interface ThreadItem {
  inbox_id: string;
  thread_id: string;
  labels: string[];
  /** Last sent or received message. */
  timestamp: string;
  /** Present only once someone has written into the thread. */
  received_timestamp?: string;
  /** Present only once the inbox has written in the thread. */
  sent_timestamp?: string;
  senders: string[];
  recipients: string[];
  subject?: string;
  preview?: string;
  attachments?: Attachment[];
  last_message_id: string;
  message_count: number;
  updated_at: string;
  created_at: string;
}

export interface Thread extends ThreadItem {
  messages: Message[];
}

export interface SendResult {
  message_id: string;
  thread_id: string;
}

export interface SendInput {
  to: string | readonly string[];
  subject?: string;
  text?: string;
  html?: string;
  cc?: string | readonly string[];
  bcc?: string | readonly string[];
  labels?: readonly string[];
}

export interface ReplyInput {
  text?: string;
  html?: string;
  cc?: string | readonly string[];
  bcc?: string | readonly string[];
  /** Reply to every recipient of the original, not just its sender. */
  replyAll?: boolean;
  labels?: readonly string[];
}

export interface ListQuery {
  limit?: number;
  pageToken?: string;
  labels?: readonly string[];
  includeTrash?: boolean;
  includeSpam?: boolean;
}

interface ListThreadsResponse {
  count: number;
  next_page_token?: string;
  threads: ThreadItem[];
}

interface ListMessagesResponse {
  count: number;
  next_page_token?: string;
  messages: MessageItem[];
}

interface SearchMessagesResponse {
  count: number;
  next_page_token?: string;
  messages: MessageItem[];
}

export interface Webhook {
  webhook_id: string;
  url: string;
  event_types?: string[];
  secret: string;
  enabled: boolean;
  client_id?: string;
}

/** List projections leave the signing secret out; only create/get carry it. */
type WebhookItem = Omit<Webhook, "secret"> & { secret?: string };

// --- Inbox resolution -----------------------------------------------------

// Provisioning is find-or-create so "give the agent an email address" needs
// nothing but an API key: pin one with AGENTMAIL_INBOX_ID, otherwise reuse the
// inbox carrying our client id, otherwise create it. AgentMail treats
// client_id as an idempotency key, so a racing create returns the same inbox.
//
// A custom domain changes which inbox is primary. Inboxes cannot be renamed,
// so each domain gets its own inbox under a domain-scoped client id, and
// resolution prefers the inbox on the effective domain: AGENTMAIL_INBOX_DOMAIN
// when set, otherwise the connected domain stored in Neon once it verifies.
// The old inbox stays behind with its mail; pin it to look at it again.
let inboxPromise: Promise<Inbox> | null = null;

/**
 * Forget the resolved inbox so the next call re-resolves. Called when the
 * connected domain changes, since that changes which inbox is primary.
 */
export function invalidateInboxCache(): void {
  inboxPromise = null;
}

/** The domain the primary inbox should live on, or null for agentmail.to. */
async function effectiveDomain(): Promise<string | null> {
  const configured = process.env.AGENTMAIL_INBOX_DOMAIN?.trim();
  if (configured !== undefined && configured.length > 0) return configured.toLowerCase();
  try {
    // The address only moves once the domain has actually verified; until
    // then mail must keep flowing through the default inbox.
    const connected = await getConnectedDomain();
    return connected !== null && connected.verified_at !== null ? connected.domain : null;
  } catch (error) {
    console.error("Reading the connected email domain failed; using the default.", error);
    return null;
  }
}

function clientIdFor(domain: string | null): string {
  // The default id predates custom domains, so it stays bare for continuity.
  return domain === null ? INBOX_CLIENT_ID : `${INBOX_CLIENT_ID}--${domain}`;
}

/** A usable inbox username: configured, else carried over, else the default. */
function desiredUsername(inboxes: Inbox[]): string | undefined {
  const configured = process.env.AGENTMAIL_INBOX_USERNAME?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  // Moving domains should keep the local part (ruth@agentmail.to →
  // ruth@example.com), so reuse the default inbox's username when it exists.
  const original = inboxes.find((inbox) => inbox.client_id === INBOX_CLIENT_ID);
  const address = original?.email ?? original?.inbox_id;
  if (address !== undefined && address.includes("@")) return address.split("@")[0];
  return undefined;
}

async function resolveInbox(): Promise<Inbox> {
  const pinned = process.env.AGENTMAIL_INBOX_ID?.trim();
  if (pinned !== undefined && pinned.length > 0) {
    return await api<Inbox>(`/inboxes/${encodeURIComponent(pinned)}`);
  }

  const domain = await effectiveDomain();
  const clientId = clientIdFor(domain);
  const existing = await api<{ inboxes: Inbox[] }>("/inboxes", { query: { limit: 100 } });
  const own = existing.inboxes.find((inbox) => inbox.client_id === clientId);
  if (own !== undefined) return own;

  const username = domain === null
    ? process.env.AGENTMAIL_INBOX_USERNAME?.trim() || undefined
    : desiredUsername(existing.inboxes);
  return await api<Inbox>("/inboxes", {
    method: "POST",
    body: {
      client_id: clientId,
      ...(username !== undefined && username.length > 0 ? { username } : {}),
      ...(domain !== null ? { domain } : {}),
      display_name: process.env.AGENTMAIL_INBOX_DISPLAY_NAME?.trim() || undefined,
    },
  });
}

/** The agent's inbox, provisioning it on first use. Cached for the process. */
export async function getInbox(): Promise<Inbox> {
  // A failed lookup must not poison the cache, or a transient 500 would break
  // email for the rest of the process's life.
  inboxPromise ??= resolveInbox().catch((error: unknown) => {
    inboxPromise = null;
    throw error;
  });
  return await inboxPromise;
}

/** The agent's own email address, e.g. "ruth@agentmail.to". */
export async function getEmailAddress(): Promise<string> {
  const inbox = await getInbox();
  return inbox.email ?? inbox.inbox_id;
}

// --- Reads ----------------------------------------------------------------

export interface ThreadPage {
  threads: ThreadItem[];
  count: number;
  nextPageToken: string | null;
}

export async function listThreads(query: ListQuery = {}): Promise<ThreadPage> {
  const inbox = await getInbox();
  const response = await api<ListThreadsResponse>(
    `/inboxes/${encodeURIComponent(inbox.inbox_id)}/threads`,
    {
      query: {
        limit: query.limit ?? 25,
        page_token: query.pageToken,
        labels: query.labels,
        include_trash: query.includeTrash,
        include_spam: query.includeSpam,
      },
    },
  );
  return {
    threads: response.threads ?? [],
    count: response.count ?? 0,
    nextPageToken: response.next_page_token ?? null,
  };
}

export interface MessagePage {
  messages: MessageItem[];
  count: number;
  nextPageToken: string | null;
}

export async function listMessages(query: ListQuery = {}): Promise<MessagePage> {
  const inbox = await getInbox();
  const response = await api<ListMessagesResponse>(
    `/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages`,
    {
      query: {
        limit: query.limit ?? 25,
        page_token: query.pageToken,
        labels: query.labels,
        include_trash: query.includeTrash,
        include_spam: query.includeSpam,
      },
    },
  );
  return {
    messages: response.messages ?? [],
    count: response.count ?? 0,
    nextPageToken: response.next_page_token ?? null,
  };
}

/**
 * Sent mail as thread rows. The thread index only carries conversations with
 * received mail in them — a thread the agent alone has written to never shows
 * up there, though fetching it by id works. The message list is complete and
 * the server filters it by the system `sent` label, so Sent is built from
 * messages grouped by conversation, newest first.
 */
export async function sentThreadItems(limit = 25): Promise<ThreadItem[]> {
  const page = await listMessages({ labels: ["sent"], limit: Math.min(100, Math.max(limit * 2, 20)) });
  const byThread = new Map<string, ThreadItem>();
  for (const message of page.messages) {
    const existing = byThread.get(message.thread_id);
    if (existing !== undefined) {
      // Newest message came first, so the row is set; just count this one.
      existing.message_count += 1;
      continue;
    }
    byThread.set(message.thread_id, {
      inbox_id: message.inbox_id,
      thread_id: message.thread_id,
      labels: message.labels,
      timestamp: message.timestamp,
      sent_timestamp: message.timestamp,
      senders: [message.from],
      recipients: message.to ?? [],
      subject: message.subject,
      preview: message.preview,
      attachments: message.attachments,
      last_message_id: message.message_id,
      message_count: 1,
      updated_at: message.updated_at,
      created_at: message.created_at,
    });
  }
  return [...byThread.values()].slice(0, limit);
}

export async function getThread(threadId: string): Promise<Thread> {
  const inbox = await getInbox();
  return await api<Thread>(
    `/inboxes/${encodeURIComponent(inbox.inbox_id)}/threads/${encodeURIComponent(threadId)}`,
  );
}

export async function getMessage(messageId: string): Promise<Message> {
  const inbox = await getInbox();
  return await api<Message>(
    `/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${encodeURIComponent(normalizeMessageId(messageId))}`,
  );
}

/** Relevance-ranked full-text search across sender, recipients, subject, body. */
export async function searchMessages(
  query: string,
  options: { limit?: number } = {},
): Promise<MessageItem[]> {
  const inbox = await getInbox();
  const response = await api<SearchMessagesResponse>(
    `/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/search`,
    { query: { q: query, limit: options.limit ?? 20 } },
  );
  return response.messages ?? [];
}

export interface AttachmentDownload {
  attachment_id: string;
  /** Short-lived signed URL; see `expires_at`. */
  download_url: string;
  expires_at: string;
  filename?: string;
  content_type?: string;
  size: number;
}

export async function getAttachment(
  messageId: string,
  attachmentId: string,
): Promise<AttachmentDownload> {
  const inbox = await getInbox();
  return await api<AttachmentDownload>(
    `/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${encodeURIComponent(normalizeMessageId(messageId))}` +
      `/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

// --- Writes ---------------------------------------------------------------

export async function sendMessage(
  input: SendInput,
  options: { idempotencyKey?: string } = {},
): Promise<SendResult> {
  const inbox = await getInbox();
  return await api<SendResult>(
    `/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`,
    {
      method: "POST",
      idempotencyKey: options.idempotencyKey,
      body: {
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.text,
        html: input.html,
        labels: input.labels,
      },
    },
  );
}

export async function replyToMessage(
  messageId: string,
  input: ReplyInput,
  options: { idempotencyKey?: string } = {},
): Promise<SendResult> {
  const inbox = await getInbox();
  return await api<SendResult>(
    `/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${encodeURIComponent(normalizeMessageId(messageId))}/reply`,
    {
      method: "POST",
      idempotencyKey: options.idempotencyKey,
      body: {
        text: input.text,
        html: input.html,
        cc: input.cc,
        bcc: input.bcc,
        reply_all: input.replyAll,
        labels: input.labels,
      },
    },
  );
}

/**
 * Add and remove labels on a message. AgentMail has no read/unread endpoint —
 * state lives in labels, and `trash` is itself a label.
 */
export async function updateMessageLabels(
  messageId: string,
  changes: { add?: readonly string[]; remove?: readonly string[] },
): Promise<void> {
  const inbox = await getInbox();
  await api(
    `/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${encodeURIComponent(normalizeMessageId(messageId))}`,
    {
      method: "PATCH",
      body: {
        add_labels: changes.add === undefined ? undefined : [...changes.add],
        remove_labels: changes.remove === undefined ? undefined : [...changes.remove],
      },
    },
  );
}

export async function updateThreadLabels(
  threadId: string,
  changes: { add?: readonly string[]; remove?: readonly string[] },
): Promise<void> {
  const inbox = await getInbox();
  await api(
    `/inboxes/${encodeURIComponent(inbox.inbox_id)}/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: {
        add_labels: changes.add === undefined ? undefined : [...changes.add],
        remove_labels: changes.remove === undefined ? undefined : [...changes.remove],
      },
    },
  );
}

// --- Custom domains ---------------------------------------------------------

export type DomainStatus =
  | "NOT_STARTED"
  | "PENDING"
  | "INVALID"
  | "FAILED"
  | "VERIFYING"
  | "VERIFIED";

export interface DomainRecord {
  type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  status: "MISSING" | "INVALID" | "VALID";
  /** MX records only. */
  priority?: number;
}

export interface EmailDomain {
  domain_id: string;
  domain: string;
  status: DomainStatus;
  /** The DNS records that must exist at the registrar for mail to flow. */
  records: DomainRecord[];
  created_at: string;
  updated_at: string;
}

export async function createDomain(domain: string): Promise<EmailDomain> {
  return await api<EmailDomain>("/domains", { method: "POST", body: { domain } });
}

export async function getDomain(domainId: string): Promise<EmailDomain> {
  return await api<EmailDomain>(`/domains/${encodeURIComponent(domainId)}`);
}

export async function listDomains(): Promise<EmailDomain[]> {
  const response = await api<{ domains?: EmailDomain[] }>("/domains", {
    query: { limit: 100 },
  });
  return response.domains ?? [];
}

/**
 * Kicks (or re-kicks) verification. AgentMail checks records on its own once
 * they propagate; this is the documented remedy for NOT_STARTED and FAILED.
 */
export async function verifyDomain(domainId: string): Promise<void> {
  await api(`/domains/${encodeURIComponent(domainId)}/verify`, { method: "POST" });
}

export async function deleteDomain(domainId: string): Promise<void> {
  await api(`/domains/${encodeURIComponent(domainId)}`, { method: "DELETE" });
}

// --- Webhook registration -------------------------------------------------

/**
 * Registers (or reuses) the `message.received` webhook that wakes the agent
 * on inbound mail. `client_id` makes this idempotent, so callers can ensure
 * on every boot. Returns the webhook including its Svix signing secret - the
 * list endpoint omits secrets, so an adopted webhook is read back by id.
 */
export async function ensureInboundWebhook(url: string, clientId: string): Promise<Webhook> {
  const existing = await api<{ webhooks?: WebhookItem[] }>("/webhooks", { query: { limit: 100 } });
  const match = (existing.webhooks ?? []).find((hook) => hook.client_id === clientId);
  if (match === undefined) {
    return await api<Webhook>("/webhooks", {
      method: "POST",
      body: { url, event_types: ["message.received"], client_id: clientId },
    });
  }
  if (match.url !== url || !match.enabled) {
    await api(`/webhooks/${encodeURIComponent(match.webhook_id)}`, {
      method: "PATCH",
      body: { url, enabled: true },
    });
  }
  return await api<Webhook>(`/webhooks/${encodeURIComponent(match.webhook_id)}`);
}

/**
 * AgentMail message ids are RFC-5322 style, `<local@domain>`. Those angle
 * brackets survive round trips badly: a model that has seen the id rendered
 * will sometimes hand back `&lt;id&gt;`, or drop the brackets entirely, and
 * either spelling 404s. Repair both rather than fail a send over punctuation.
 */
export function normalizeMessageId(raw: string): string {
  const unescaped = raw
    .trim()
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .trim();
  const bare = unescaped.includes("@") && !unescaped.startsWith("<") && !unescaped.endsWith(">");
  return bare ? `<${unescaped}>` : unescaped;
}

// --- Presentation helpers -------------------------------------------------

/** `"Ada Lovelace <ada@example.com>"` → `{ name, address }`. */
export function parseAddress(raw: string): { name: string | null; address: string } {
  const angled = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  if (angled === null) return { name: null, address: raw.trim() };
  const name = angled[1].replace(/^["']|["']$/g, "").trim();
  return { name: name.length > 0 ? name : null, address: angled[2].trim() };
}

/** Best available plain-text body: new content first, then the full message. */
export function messageBody(message: Message): string {
  const candidates = [message.extracted_text, message.text];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim().length > 0) return candidate;
  }
  const html = message.extracted_html ?? message.html;
  if (html !== undefined && html.trim().length > 0) return htmlToText(html);
  return message.preview ?? "";
}

/** Crude HTML → text, for messages that arrive HTML-only. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Clips a body for tool output and prompts, which don't need every quoted line. */
export function clipBody(body: string, maxChars = 4000): string {
  const trimmed = body.trim();
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars).trimEnd()}\n… (truncated; read the full message for the rest)`
    : trimmed;
}
