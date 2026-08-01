import type { HandleMessageStreamEvent, SessionState } from "eve/client";
import { isCurrentTurnBoundaryEvent } from "eve/client";

import type { EveHeadersResolver } from "./eve-auth-client";

/**
 * Client-side persistence engine for web chat threads.
 *
 * Transcripts are dual-written: localStorage is the same-device cache that
 * makes thread switches instant and reloads lossless, and Neon (via
 * `/api/threads`) is the durable copy that survives cleared storage and other
 * devices. This module owns everything that makes those writes reliable:
 *
 * - a per-thread server write queue that serializes, coalesces, and retries
 *   PUT/DELETE calls (fire-and-forget fetches used to drop chats silently);
 * - an unload flush that pushes pending writes with `keepalive` when the page
 *   is being hidden or closed;
 * - compaction that strips multi-megabyte inline data URLs (attachments,
 *   screenshots) from the persisted copy so neither the localStorage quota
 *   nor the server's request-body limit can wipe out a whole thread;
 * - quota-aware local saves that evict the coldest cached thread instead of
 *   silently dropping the active one;
 * - delete tombstones so a thread removed on this device cannot be
 *   resurrected by a later sync racing a failed server DELETE;
 * - sessionStorage-backed composer drafts so a reload mid-typing keeps the
 *   text.
 */

// --- Types shared with the chat UI ---

export interface SavedChat {
  events?: readonly HandleMessageStreamEvent[];
  session?: SessionState;
  /**
   * A user message saved before eve accepts the turn. This is deliberately
   * separate from `events`: synthetic stream events would shift every saved
   * stream index and make durable-session resume read from the wrong place.
   */
  pendingMessage?: PendingUserMessage;
  /**
   * Write stamp of this copy. For copies written by this module it equals the
   * thread meta's `updatedAt` at write time, which is what lets staleness
   * checks compare a local copy against server metadata without caring whose
   * clock produced either value.
   */
  savedAt?: number;
  /**
   * The durable session log is known to continue past this copy's tail (a
   * tail probe found more events, but no mounted view could catch up at that
   * moment). A copy like this ends at a clean turn boundary and would
   * otherwise look settled; the flag makes the next mount reattach and read
   * to the verified tail, which clears it.
   */
  behind?: boolean;
  /**
   * Set on threads forked from a message. eve sessions are append-only, so a
   * fork starts a fresh session; this transcript rides along as one-turn
   * client context on the fork's first send so the agent knows the history.
   */
  forkContext?: string;
}

export type PendingUserMessagePart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "file";
      filename: string;
      mediaType: string;
      size: number;
    };

export interface PendingUserMessage {
  id: string;
  createdAt: number;
  baseEventCount: number;
  parts: PendingUserMessagePart[];
  status: "sending" | "failed";
  error?: string;
  useComputer: boolean;
}

export interface ThreadMeta {
  id: string;
  title: string;
  updatedAt: number;
  pinned?: boolean;
  /** Set once the user renames a thread, so auto-titles stop overwriting it. */
  renamed?: boolean;
  /** Who started the thread; proactive threads get a sidebar badge. */
  origin?: "web" | "reminder" | "webhook" | "email" | "notification" | "voice";
}

// --- localStorage chat cache ---

const CHAT_KEY_PREFIX = "eve-web-chat:";
/** Same-tab companion to the browser's cross-tab-only `storage` event. */
export const LOCAL_CHAT_SAVED_EVENT = "eve:chat-saved";

export function chatKey(threadId: string): string {
  return `${CHAT_KEY_PREFIX}${threadId}`;
}

export function loadSavedChat(threadId: string): SavedChat | null {
  try {
    const raw = localStorage.getItem(chatKey(threadId));
    return raw ? (JSON.parse(raw) as SavedChat) : null;
  } catch {
    return null;
  }
}

/**
 * Writes a chat copy to localStorage exactly as given (callers stamp
 * `savedAt`). When the quota is exhausted, evicts the coldest other cached
 * chats and retries: localStorage is a cache of the server copy, so dropping
 * a cold thread is recoverable while dropping the active write is not.
 */
export function saveLocalChat(threadId: string, chat: SavedChat): void {
  const key = chatKey(threadId);
  const payload = JSON.stringify(chat);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      localStorage.setItem(key, payload);
      if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
        window.dispatchEvent(
          new CustomEvent<{ threadId: string }>(LOCAL_CHAT_SAVED_EVENT, {
            detail: { threadId },
          }),
        );
      }
      return;
    } catch {
      if (!evictColdestChat(key)) return;
    }
  }
}

/**
 * Builds the durable projection of an outgoing message. Attachment bytes and
 * data URLs are intentionally not accepted by this API, so saved drafts stay
 * small and a failed attachment send can only be retried after reattachment.
 */
export function createPendingUserMessage(input: {
  id: string;
  createdAt: number;
  baseEventCount: number;
  text: string;
  files: readonly { filename: string; mediaType: string; size: number }[];
  useComputer: boolean;
}): PendingUserMessage {
  return {
    id: input.id,
    createdAt: input.createdAt,
    baseEventCount: input.baseEventCount,
    parts: [
      ...(input.text.length > 0 ? [{ type: "text" as const, text: input.text }] : []),
      ...input.files.map((file) => ({ type: "file" as const, ...file })),
    ],
    status: "sending",
    useComputer: input.useComputer,
  };
}

/** Text that can be restored to the composer after a failed send. */
export function pendingMessageText(message: PendingUserMessage): string {
  return message.parts
    .filter((part): part is Extract<PendingUserMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Marks a pre-confirmation send failure without mutating the saved copy. */
export function failPendingMessage(
  message: PendingUserMessage,
  error: string,
): PendingUserMessage {
  return { ...message, status: "failed", error };
}

/**
 * Exact structured echo matching for the pending projection. A replayed
 * message with different text or file metadata must not confirm a newer send.
 */
export function pendingMessageMatchesEvent(
  pending: PendingUserMessage,
  event: HandleMessageStreamEvent,
): boolean {
  if (event.type !== "message.received") return false;
  const receivedParts = event.data.parts;
  if (!Array.isArray(receivedParts)) {
    return (
      pending.parts.length === 1 &&
      pending.parts[0]?.type === "text" &&
      messageEchoText(event) === pending.parts[0].text.trim()
    );
  }
  if (receivedParts.length !== pending.parts.length) return false;
  return pending.parts.every((part, index) => {
    const received = receivedParts[index];
    if (part.type !== received?.type) return false;
    if (part.type === "text" && received.type === "text") {
      return part.text.trim() === received.text.trim();
    }
    if (part.type === "file" && received.type === "file") {
      return (
        part.filename === (received.filename ?? "") &&
        part.mediaType === received.mediaType &&
        (received.size === undefined || part.size === received.size)
      );
    }
    return false;
  });
}

export function reconcilePendingMessage(
  pending: PendingUserMessage | undefined,
  event: HandleMessageStreamEvent,
): PendingUserMessage | undefined {
  return pending !== undefined && pendingMessageMatchesEvent(pending, event)
    ? undefined
    : pending;
}

/**
 * Whether an incoming saved copy advances the mounted one. Event logs are
 * authoritative and append-only, so a shorter log always loses even if some
 * secondary field is newer.
 */
export function savedChatHasProgress(current: SavedChat, incoming: SavedChat): boolean {
  const currentEventCount = current.events?.length ?? 0;
  const incomingEventCount = incoming.events?.length ?? 0;
  if (incomingEventCount < currentEventCount) return false;
  if (incomingEventCount > currentEventCount) return true;

  if (
    current.session?.sessionId === undefined &&
    incoming.session?.sessionId !== undefined
  ) {
    return true;
  }
  if (
    (incoming.session?.streamIndex ?? 0) >
    (current.session?.streamIndex ?? 0)
  ) {
    return true;
  }

  const currentPending = current.pendingMessage;
  const incomingPending = incoming.pendingMessage;
  if (currentPending?.status === "sending") {
    if (incomingPending === undefined) return true;
    if (
      incomingPending.id === currentPending.id &&
      incomingPending.status === "failed"
    ) {
      return true;
    }
  }
  if (currentPending === undefined && incomingPending !== undefined) return true;
  if (
    currentPending !== undefined &&
    incomingPending !== undefined &&
    currentPending.id !== incomingPending.id &&
    (incoming.savedAt ?? 0) > (current.savedAt ?? 0)
  ) {
    return true;
  }
  if (
    currentPending?.id === incomingPending?.id &&
    currentPending?.status === incomingPending?.status &&
    currentPending?.error !== incomingPending?.error
  ) {
    return true;
  }

  return current.behind !== incoming.behind;
}

/** Removes the least-recently-written cached chat other than `exceptKey`. */
function evictColdestChat(exceptKey: string): boolean {
  try {
    let coldestKey: string | null = null;
    let coldestAt = Infinity;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key === null || key === exceptKey || !key.startsWith(CHAT_KEY_PREFIX)) continue;
      let savedAt = 0;
      try {
        savedAt = (JSON.parse(localStorage.getItem(key) ?? "{}") as SavedChat).savedAt ?? 0;
      } catch {
        // Unparseable entry: evict it first.
      }
      if (savedAt < coldestAt) {
        coldestAt = savedAt;
        coldestKey = key;
      }
    }
    if (coldestKey === null) return false;
    localStorage.removeItem(coldestKey);
    return true;
  } catch {
    return false;
  }
}

// --- Payload compaction ---

/**
 * Inline data URLs (pasted files, screenshot tool output) can run to many
 * megabytes per event. Persisting them verbatim used to kill the whole
 * thread: the localStorage write throws past ~5 MB and the server PUT
 * exceeds the platform's request-body limit, both silently. The persisted
 * copy replaces any oversized data URL with a small stub; the live in-memory
 * view keeps full fidelity, and stripping inside events (rather than
 * dropping events) keeps stream indexes aligned for session resume.
 */
export const STRIPPED_URL_PREFIX = "data:text/x-eve-stripped,";

export function isStrippedUrl(value: string): boolean {
  return value.startsWith(STRIPPED_URL_PREFIX);
}

const STRIP_THRESHOLD = 128 * 1024;
const AGGRESSIVE_STRIP_THRESHOLD = 8 * 1024;
/** Serialized budget after the first pass; past it, strip aggressively. */
const CHAT_BYTE_BUDGET = 2_500_000;

function stripLargeString(value: string, threshold: number): string {
  if (value.length <= threshold || !value.startsWith("data:") || isStrippedUrl(value)) {
    return value;
  }
  const separator = value.search(/[;,]/);
  const mediaType = separator > 5 ? value.slice(5, separator) : "unknown";
  return `${STRIPPED_URL_PREFIX}${mediaType} ~${Math.round(value.length / 1024)} kB omitted from saved copy`;
}

function compactValue(value: unknown, threshold: number): unknown {
  if (typeof value === "string") return stripLargeString(value, threshold);
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let i = 0; i < value.length; i += 1) {
      const compacted = compactValue(value[i], threshold);
      if (compacted !== value[i] && copy === null) copy = [...value];
      if (copy !== null) copy[i] = compacted;
    }
    return copy ?? value;
  }
  if (value !== null && typeof value === "object") {
    let copy: Record<string, unknown> | null = null;
    for (const [key, entry] of Object.entries(value)) {
      const compacted = compactValue(entry, threshold);
      if (compacted !== entry && copy === null) copy = { ...(value as Record<string, unknown>) };
      if (copy !== null) copy[key] = compacted;
    }
    return copy ?? value;
  }
  return value;
}

export function compactChatForStorage(chat: SavedChat): SavedChat {
  const events = chat.events;
  if (events === undefined || events.length === 0) return chat;
  let compacted = compactValue(events, STRIP_THRESHOLD) as SavedChat["events"];
  try {
    if (JSON.stringify(compacted).length > CHAT_BYTE_BUDGET) {
      compacted = compactValue(compacted, AGGRESSIVE_STRIP_THRESHOLD) as SavedChat["events"];
    }
  } catch {
    // Serialization failure falls through to the storage layer's own guard.
  }
  return compacted === events ? chat : { ...chat, events: compacted };
}

// --- Server write queue (Neon via /api/threads) ---

interface PendingWrite {
  meta: ThreadMeta;
  /** Present for chat writes; absent for meta-only writes (rename, pin). */
  chat?: SavedChat;
  delete?: boolean;
}

interface ThreadWriter {
  inFlight: boolean;
  next: PendingWrite | null;
  attempt: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
}

const writers = new Map<string, ThreadWriter>();
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Browsers cap keepalive request bodies around 64 kB. */
const KEEPALIVE_BODY_LIMIT = 60_000;

let unloading = false;
let unloadHooksInstalled = false;

/**
 * On pagehide (reload, close, navigation) pending writes are dispatched
 * immediately with `keepalive` so they survive the page's death. Oversized
 * bodies can't ride keepalive; those threads are re-pushed by the next
 * load's reconciliation sweep, which compares local `savedAt` stamps with
 * the server's thread list.
 */
function ensureUnloadHooks(): void {
  if (unloadHooksInstalled || typeof window === "undefined") return;
  unloadHooksInstalled = true;
  window.addEventListener("pagehide", () => {
    unloading = true;
    flushPendingWrites();
  });
  // A bfcache restore brings the page back alive after pagehide.
  window.addEventListener("pageshow", () => {
    unloading = false;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingWrites();
  });
}

function flushPendingWrites(): void {
  for (const [id, writer] of writers) {
    if (writer.retryTimer !== undefined) {
      clearTimeout(writer.retryTimer);
      writer.retryTimer = undefined;
    }
    dispatch(id);
  }
}

function mergeWrites(pending: PendingWrite | null, incoming: PendingWrite): PendingWrite {
  if (pending === null || pending.delete === true || incoming.delete === true) return incoming;
  // Latest meta always wins; a meta-only write keeps the queued chat payload.
  return { meta: incoming.meta, chat: incoming.chat ?? pending.chat };
}

function enqueue(id: string, write: PendingWrite): void {
  ensureUnloadHooks();
  let writer = writers.get(id);
  if (writer === undefined) {
    writer = { inFlight: false, next: null, attempt: 0, retryTimer: undefined };
    writers.set(id, writer);
  }
  writer.next = mergeWrites(writer.next, write);
  // Fresh state supersedes any backoff wait for the previous payload.
  if (writer.retryTimer !== undefined) {
    clearTimeout(writer.retryTimer);
    writer.retryTimer = undefined;
    writer.attempt = 0;
  }
  dispatch(id);
}

function dispatch(id: string): void {
  const writer = writers.get(id);
  if (writer === undefined || writer.inFlight || writer.next === null) return;
  const write = writer.next;
  writer.next = null;
  writer.inFlight = true;
  void performWrite(id, write).then((ok) => {
    writer.inFlight = false;
    if (!ok && writer.next !== null) {
      // The write failed and something newer was queued during the request.
      // A meta-only successor (rename, pin) must not swallow the failed
      // write's chat payload, so carry the transcript into the follow-up
      // instead of dropping it until the next reconciliation sweep.
      writer.next = mergeWrites(write, writer.next);
    }
    if (ok || writer.next !== null) {
      // Success, or a newer payload arrived while this one was in flight:
      // either way the queued state is what matters now.
      writer.attempt = 0;
      if (writer.next === null) writers.delete(id);
      else dispatch(id);
      return;
    }
    writer.attempt += 1;
    if (writer.attempt >= MAX_ATTEMPTS) {
      // Give up for now; the periodic reconciliation sweep re-queues threads
      // whose local copy is ahead of the server.
      writer.attempt = 0;
      writers.delete(id);
      return;
    }
    writer.next = write;
    if (unloading) return;
    writer.retryTimer = setTimeout(() => {
      writer.retryTimer = undefined;
      dispatch(id);
    }, RETRY_BASE_MS * 2 ** (writer.attempt - 1));
  });
}

function threadMetaBody(meta: ThreadMeta) {
  return {
    title: meta.title,
    updatedAt: meta.updatedAt,
    pinned: meta.pinned === true,
    renamed: meta.renamed === true,
    origin: meta.origin,
  };
}

async function performWrite(id: string, write: PendingWrite): Promise<boolean> {
  try {
    if (write.delete === true) {
      const response = await fetch(`/api/threads/${id}`, {
        method: "DELETE",
        keepalive: unloading,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.ok;
    }
    const body = JSON.stringify({
      ...threadMetaBody(write.meta),
      ...(write.chat !== undefined ? { chat: write.chat } : {}),
    });
    const response = await fetch(`/api/threads/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: unloading && body.length < KEEPALIVE_BODY_LIMIT,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Queues a chat (or meta-only, when `chat` is omitted) write for a thread. */
export function queueThreadUpsert(meta: ThreadMeta, chat?: SavedChat): void {
  // A deleted thread must stay deleted: a persist racing the delete (e.g. a
  // backgrounded turn's flush landing just after the user deletes the
  // thread) must not replace the queued DELETE or recreate the row behind
  // it. Legitimate recreation - a newer write from another device - clears
  // the tombstone before anything is queued.
  if (loadTombstones()[meta.id] !== undefined) return;
  enqueue(meta.id, { meta, ...(chat !== undefined ? { chat } : {}) });
}

export function queueThreadDelete(id: string): void {
  enqueue(id, { meta: { id, title: "", updatedAt: 0 }, delete: true });
}

// --- Server reads ---

export async function fetchServerThreads(): Promise<ThreadMeta[] | null> {
  try {
    const response = await fetch("/api/threads");
    if (!response.ok) return null;
    const body = (await response.json()) as { threads?: ThreadMeta[] };
    return Array.isArray(body.threads) ? body.threads : null;
  } catch {
    return null;
  }
}

/**
 * The server's copy of a thread. Null is definitive — the server answered
 * and has no such thread (404, including deployments without a thread
 * store). "unreachable" is a failed question (network, auth, 5xx) that
 * proves nothing about the thread's existence.
 */
export async function fetchServerChat(id: string): Promise<SavedChat | null | "unreachable"> {
  try {
    const response = await fetch(`/api/threads/${id}`);
    if (response.status === 404) return null;
    if (!response.ok) return "unreachable";
    const body = (await response.json()) as { chat?: SavedChat };
    return body.chat ?? null;
  } catch {
    return "unreachable";
  }
}

// --- Delete tombstones ---

export const TOMBSTONES_KEY = "eve-web-thread-tombstones";
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Deleted thread ids -> deletion time; pruned of entries past their TTL. */
export function loadTombstones(): Record<string, number> {
  try {
    const raw = localStorage.getItem(TOMBSTONES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    const pruned: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && at >= cutoff) pruned[id] = at;
    }
    return pruned;
  } catch {
    return {};
  }
}

function saveTombstones(tombstones: Record<string, number>): void {
  try {
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(tombstones));
  } catch {
    // Storage unavailable; deletes still reach the server via the queue.
  }
}

export function recordTombstone(id: string): void {
  saveTombstones({ ...loadTombstones(), [id]: Date.now() });
}

export function clearTombstone(id: string): void {
  const tombstones = loadTombstones();
  if (!(id in tombstones)) return;
  delete tombstones[id];
  saveTombstones(tombstones);
}

// --- Session catch-up ---

/**
 * The exact text a `message.received` event echoes for the user's message.
 * `data.parts` preserves the sent text parts verbatim - for plain string
 * sends and attachment sends alike - so joining them reproduces precisely
 * what the client recorded at send time (`data.message` is a summary that
 * appends attachment markers; it is only a fallback). Echo matching uses
 * full equality on this value: substring matching mistook older messages
 * that merely *contained* the sent text for the echo, which suppressed
 * mismatch detection or stopped catch-up at the wrong turn's boundary.
 */
export function messageEchoText(event: HandleMessageStreamEvent): string {
  if (event.type !== "message.received") return "";
  const { message, parts } = event.data as {
    message?: unknown;
    parts?: readonly { type?: unknown; text?: unknown }[];
  };
  if (Array.isArray(parts)) {
    const text = parts
      .filter(
        (part): part is { type: "text"; text: string } =>
          part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return typeof message === "string" ? message.trim() : "";
}

/**
 * How long a tail probe waits for the stream route to answer. The route
 * responds as soon as the requested event exists (observed in tens of
 * milliseconds); the deadline only has to cover request latency, not any
 * think time, because "no answer" *is* the at-tail signal.
 */
const TAIL_PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether the session's durable log contains an event at `index` - an
 * authoritative "are we at the tail?" check via a fresh short-lived request,
 * independent of any long-lived catch-up stream (whose reconnect backoff
 * must not be mistaken for the tail).
 *
 * The stream route long-polls: it produces the event at `startIndex` as soon
 * as it exists (observed in tens of milliseconds) and stays silent while it
 * does not. The proof of existence is the first *non-whitespace* body byte:
 * every event is a JSON line, so event data always starts with one. This
 * deliberately does not trust response headers, which a server or proxy may
 * flush before any event exists - and on Vercel that flush arrives as a bare
 * newline in the body itself, which must read as silence or a probe at the
 * true tail reports "behind" and the caller's catch-up never settles.
 *
 * Only the probe deadline elapsing - silence from a route that answers the
 * moment the event exists - reports the tail. Everything else (an error
 * status, a closed-empty response, a network failure) is inconclusive and
 * reports `true`: the caller then keeps following its stream instead of
 * settling short, and the stream's own error handling owns the giving-up
 * decision.
 */
export async function sessionHasEventAt(
  sessionId: string,
  index: number,
  resolveHeaders?: EveHeadersResolver,
): Promise<boolean> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), TAIL_PROBE_TIMEOUT_MS);
  try {
    const headers = await resolveHeaders?.();
    const response = await fetch(
      `/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${index}`,
      {
        signal: controller.signal,
        ...(headers === undefined ? {} : { headers, redirect: "error" as const }),
      },
    );
    if (!response.ok || response.body === null) return true;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return true;
        if (value !== undefined && value.some((byte) => byte !== 0x0a && byte !== 0x0d)) {
          return true;
        }
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  } catch {
    // Our own deadline firing is the at-tail signal; anything else is a
    // transport failure and inconclusive.
    return !controller.signal.aborted;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * How a catch-up read stopped. Only `"tail"` (the probe confirmed no event
 * exists past the last consumed one) and `"park"` (the session is waiting on
 * human input, which the composer answers) are verified settles; `"ended"`
 * means the transport gave up before the tail could be verified, so the
 * caller must keep the copy marked {@link SavedChat.behind}.
 */
export type CatchUpStop = "tail" | "park" | "ended";

/**
 * Only authoritative recovery stops prove that the durable turn no longer
 * owns shared resources. A closed or failed transport can leave the session
 * running beyond the local copy, so callers must retain any active lease.
 */
export function isVerifiedCatchUpStop(
  stop: CatchUpStop | "failed",
): stop is "tail" | "park" {
  return stop === "tail" || stop === "park";
}

/**
 * ClientSession replaces its state object only after the send POST has been
 * accepted. If the subsequent response stream fails without a durable turn
 * boundary, Computer ownership must stay pinned while catch-up verifies the
 * session instead of treating the transport error as turn completion.
 */
export function acceptedComputerSendNeedsRecovery(input: {
  useComputer: boolean;
  reachedBoundary: boolean;
  sessionBeforeSend: SessionState | undefined;
  sessionAfterError: SessionState | undefined;
}): boolean {
  return (
    input.useComputer &&
    !input.reachedBoundary &&
    input.sessionAfterError !== undefined &&
    input.sessionAfterError !== input.sessionBeforeSend
  );
}

/**
 * Reads a session catch-up stream until it reaches the log's verified tail,
 * feeds every event to `onEvent`, and reports how it stopped:
 *
 * - At each turn boundary, `hasEventAfter(consumedCount)` (normally a
 *   {@link sessionHasEventAt} probe) decides whether the log continues. If
 *   it does, reading simply carries on - however many turns the copy was
 *   behind, and however long the transport takes to deliver them. If it
 *   does not, the boundary was the tail and the catch-up settles (`"tail"`).
 * - Human-input parks settle immediately (`"park"`) - the composer answers
 *   those.
 *
 * The stop is verified, never guessed. No idle timer (a transient
 * disconnect's reconnect backoff would read as silence), no text matching
 * against the backlog (duplicate message text would read as a false tail),
 * and no turn cap (a deep backlog would settle short). If the stream itself
 * ends first (`"ended"`), the caller settles with what arrived but must not
 * present the copy as settled - the log may continue past it.
 */
export async function readCatchUpStream(
  stream: AsyncIterable<HandleMessageStreamEvent>,
  hasEventAfter: (consumedCount: number) => Promise<boolean>,
  onEvent: (event: HandleMessageStreamEvent) => void,
): Promise<CatchUpStop> {
  let consumed = 0;
  for await (const event of stream) {
    consumed += 1;
    onEvent(event);
    if (event.type === "input.requested" || event.type === "authorization.required") {
      return "park";
    }
    if (isCurrentTurnBoundaryEvent(event) && !(await hasEventAfter(consumed))) return "tail";
  }
  return "ended";
}

// --- Composer draft memory ---

// sessionStorage: drafts survive reloads and revision remounts of the thread
// component, but don't follow the user across tabs or linger for weeks.
function draftKey(threadId: string): string {
  return `eve-web-draft:${threadId}`;
}

export function loadDraft(threadId: string): string {
  try {
    return sessionStorage.getItem(draftKey(threadId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(threadId: string, text: string): void {
  try {
    if (text.length === 0) sessionStorage.removeItem(draftKey(threadId));
    else sessionStorage.setItem(draftKey(threadId), text);
  } catch {
    // Storage unavailable; the draft only lives in component state.
  }
}
