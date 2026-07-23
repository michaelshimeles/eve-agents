"use client";

import type { UserContent } from "ai";
import type { HandleMessageStreamEvent, SessionState } from "eve/client";
import { useEveAgent } from "eve/react";
import type { EveMessage, EveMessagePart } from "eve/react";
import { Dialog, TextField } from "frosted-ui";
import { Button, LinkButton, Loader } from "@/components/ui/compat";
import {
  AlarmIcon,
  ArrowClockwiseIcon,
  ArrowUpIcon,
  BellIcon,
  BellSlashIcon,
  CaretDownIcon,
  CheckIcon,
  CopyIcon,
  FileIcon,
  GearSixIcon,
  GitBranchIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  KeyIcon,
  MicrophoneIcon,
  PaperclipIcon,
  PencilSimpleIcon,
  PlusIcon,
  PushPinIcon,
  PushPinSlashIcon,
  SidebarSimpleIcon,
  SparkleIcon,
  StarIcon,
  StopIcon,
  TrashIcon,
  WrenchIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { CommandPalette } from "@/components/command-palette";
import { ManagePanel } from "@/components/manage-panel";
import { Markdown } from "@/components/markdown";
import { usePushNotifications } from "@/components/use-push";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { cn } from "@/lib/utils";

const THREADS_KEY = "eve-web-threads";
const SEEN_KEY = "eve-web-threads-seen";
const LEGACY_CHAT_KEY = "eve-web-chat";
const MODEL_KEY = "eve-web-model";
const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5";

interface ModelOption {
  id: string;
  name: string;
  description?: string | null;
  pricing?: { input: string; output: string } | null;
}

const MODEL_FAVORITES_KEY = "eve-web-model-favorites";

function loadModelFavorites(): string[] {
  try {
    const raw = localStorage.getItem(MODEL_FAVORITES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function modelProvider(id: string): string {
  return id.split("/")[0] ?? id;
}

/** Rough cost tier from the per-token input price: $ under $1/M, $$ under $5/M, $$$ above. */
function priceTier(pricing: ModelOption["pricing"]): string {
  const perToken = Number(pricing?.input);
  if (!Number.isFinite(perToken) || perToken <= 0) return "";
  const perMillion = perToken * 1_000_000;
  return perMillion < 1 ? "$" : perMillion < 5 ? "$$" : "$$$";
}

function loadSavedModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? DEFAULT_MODEL_ID;
  } catch {
    return DEFAULT_MODEL_ID;
  }
}

function chatKey(threadId: string): string {
  return `eve-web-chat:${threadId}`;
}

interface SavedChat {
  events?: readonly HandleMessageStreamEvent[];
  session?: SessionState;
  /** When this device wrote the copy; lets cross-device sync spot staleness. */
  savedAt?: number;
  /**
   * Set on threads forked from a message. eve sessions are append-only, so a
   * fork starts a fresh session; this transcript rides along as one-turn
   * client context on the fork's first send so the agent knows the history.
   */
  forkContext?: string;
}

interface ThreadMeta {
  id: string;
  title: string;
  updatedAt: number;
  pinned?: boolean;
  /** Set once the user renames a thread, so auto-titles stop overwriting it. */
  renamed?: boolean;
  /** Who started the thread; reminder/webhook threads get a sidebar badge. */
  origin?: "web" | "reminder" | "webhook";
}

interface ThreadIndex {
  activeId: string;
  threads: ThreadMeta[];
}

function newThreadMeta(): ThreadMeta {
  return { id: crypto.randomUUID(), title: "New chat", updatedAt: Date.now() };
}

function loadThreadIndex(): ThreadIndex {
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ThreadIndex;
      if (Array.isArray(parsed.threads) && parsed.threads.length > 0) {
        const activeId = parsed.threads.some((thread) => thread.id === parsed.activeId)
          ? parsed.activeId
          : parsed.threads[0].id;
        return { activeId, threads: parsed.threads };
      }
    }
    // First run with threads: migrate the old single-chat storage into one.
    const meta = newThreadMeta();
    const legacy = localStorage.getItem(LEGACY_CHAT_KEY);
    if (legacy) {
      localStorage.setItem(chatKey(meta.id), legacy);
      localStorage.removeItem(LEGACY_CHAT_KEY);
    }
    return { activeId: meta.id, threads: [meta] };
  } catch {
    const meta = newThreadMeta();
    return { activeId: meta.id, threads: [meta] };
  }
}

function loadSavedChat(threadId: string): SavedChat | null {
  try {
    const raw = localStorage.getItem(chatKey(threadId));
    return raw ? (JSON.parse(raw) as SavedChat) : null;
  } catch {
    return null;
  }
}

function saveLocalChat(threadId: string, chat: SavedChat): void {
  try {
    localStorage.setItem(chatKey(threadId), JSON.stringify({ ...chat, savedAt: Date.now() }));
  } catch {
    // Storage full or unavailable; the server copy still gets written.
  }
}

// --- Server persistence (Neon via /api/threads, same basic-auth realm) ---

function threadMetaBody(meta: ThreadMeta) {
  return {
    title: meta.title,
    updatedAt: meta.updatedAt,
    pinned: meta.pinned === true,
    renamed: meta.renamed === true,
    origin: meta.origin,
  };
}

function putThreadToServer(meta: ThreadMeta, chat: SavedChat): void {
  void fetch(`/api/threads/${meta.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...threadMetaBody(meta), chat }),
  }).catch(() => undefined);
}

/** Persists rename/pin changes without re-uploading the chat payload. */
function putThreadMetaToServer(meta: ThreadMeta): void {
  void fetch(`/api/threads/${meta.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(threadMetaBody(meta)),
  }).catch(() => undefined);
}

function deleteThreadOnServer(id: string): void {
  void fetch(`/api/threads/${id}`, { method: "DELETE" }).catch(() => undefined);
}

async function fetchServerThreads(): Promise<ThreadMeta[] | null> {
  try {
    const response = await fetch("/api/threads");
    if (!response.ok) return null;
    const body = (await response.json()) as { threads?: ThreadMeta[] };
    return Array.isArray(body.threads) ? body.threads : null;
  } catch {
    return null;
  }
}

async function fetchServerChat(id: string): Promise<SavedChat | null> {
  try {
    const response = await fetch(`/api/threads/${id}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { chat?: SavedChat };
    return body.chat ?? null;
  } catch {
    return null;
  }
}

function toThreadTitle(text: string): string {
  const oneLine = text.replaceAll("\n", " ").trim();
  return oneLine.length > 44 ? `${oneLine.slice(0, 44).trimEnd()}…` : oneLine;
}

function deriveTitle(messages: readonly EveMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim().length > 0) {
        return toThreadTitle(part.text);
      }
    }
  }
  return null;
}

interface TurnUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k`;
  return String(count);
}

function formatUsage(usage: TurnUsage): string {
  const pieces: string[] = [];
  if (usage.costUsd > 0) {
    pieces.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 4 : 2)}`);
  }
  pieces.push(`${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`);
  return pieces.join(" · ");
}

function messageText(message: EveMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

// --- Composer attachments ---

interface PendingAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  dataUrl: string;
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

// --- Slash commands ---

interface SlashCommand {
  name: string;
  description: string;
  /** Text placed in the composer when the command is picked. */
  prompt: string;
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "schedule",
    description: "What's on the calendar today",
    prompt: "Check my schedule for today.",
  },
  {
    name: "week",
    description: "The week ahead",
    prompt: "Check my schedule for the rest of the week.",
  },
  {
    name: "hn",
    description: "Top stories on Hacker News",
    prompt: "What are the top stories on Hacker News right now?",
  },
  {
    name: "remember",
    description: "Save something to memory",
    prompt: "Remember this: ",
  },
];

function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return commands;
  return commands.filter(
    (command) =>
      command.name.toLowerCase().includes(needle) ||
      command.description.toLowerCase().includes(needle),
  );
}

// --- Voice input (Web Speech API; typed minimally since TS lacks lib types) ---

interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function CopyButton({ text, label = "Copy message" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="xs"
      shape="square"
      aria-label={label}
      icon={copied ? CheckIcon : CopyIcon}
      className="text-gray-11"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}

function ToolPayload({ label, value }: { label: string; value: unknown }) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (!text || text === "{}" || text === "undefined") return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium tracking-wide text-gray-11 uppercase">
        {label}
      </span>
      <pre className="max-h-64 overflow-auto rounded-md bg-gray-a2 p-2 font-mono text-xs break-words whitespace-pre-wrap text-gray-11">
        {text}
      </pre>
    </div>
  );
}

function hasVisibleParts(message: EveMessage): boolean {
  return message.parts.some((part) => {
    switch (part.type) {
      case "text":
      case "reasoning":
        return part.text.trim().length > 0;
      case "step-start":
        return false;
      default:
        return true;
    }
  });
}

function formatThreadDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dateGroup(timestamp: number): "Today" | "Yesterday" | "Older" {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return "Older";
}

interface ThreadSection {
  label: string | null;
  threads: ThreadMeta[];
}

function sectionThreads(
  threads: ThreadMeta[],
  query: string,
  contentMatchIds: ReadonlySet<string>,
): ThreadSection[] {
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  const needle = query.trim().toLowerCase();
  if (needle.length > 0) {
    return [
      {
        label: null,
        threads: sorted.filter(
          (t) => t.title.toLowerCase().includes(needle) || contentMatchIds.has(t.id),
        ),
      },
    ];
  }
  const groups = new Map<string, ThreadMeta[]>([
    ["Pinned", []],
    ["Today", []],
    ["Yesterday", []],
    ["Older", []],
  ]);
  for (const thread of sorted) {
    groups.get(thread.pinned ? "Pinned" : dateGroup(thread.updatedAt))!.push(thread);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([label, list]) => ({ label, threads: list }));
}

// Per-thread "last seen" timestamps behind the sidebar's unread dots. A
// thread is unread when its updatedAt has moved past the recorded seen time
// (a fired reminder created it, or another device wrote to it).
function loadSeenMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

export function Chat({ initialView = "chat" }: { initialView?: MainView } = {}) {
  // localStorage is read in useState initializers, so only mount the chat
  // on the client to avoid an SSR/hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <main className="h-dvh bg-canvas" />;
  }
  return <ChatApp initialView={initialView} />;
}

/** What the main column shows; the sidebar is shared between both. */
type MainView = "chat" | "manage";

function ChatApp({ initialView }: { initialView: MainView }) {
  const [index, setIndex] = useState<ThreadIndex>(loadThreadIndex);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The thread meta is kept separately from the open flag so the dialog's
  // text doesn't blank out during its closing animation.
  const [threadToDelete, setThreadToDelete] = useState<ThreadMeta | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  // The active thread's chat payload; null while it loads from the server.
  // revision bumps when a fresher server copy replaces the mounted one, so
  // ChatThread (keyed on it) remounts with the new events.
  const [activeChat, setActiveChat] = useState<{
    threadId: string;
    chat: SavedChat;
    revision?: number;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Thread ids whose message content matches the sidebar search (server-side
  // full-text pass); merged with the local title filter.
  const [contentMatchIds, setContentMatchIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  // Navigation command palette (Cmd+K).
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Composer prefill for a freshly forked thread (fork via "edit & resend").
  const [pendingDraft, setPendingDraft] = useState<{ threadId: string; text: string } | null>(
    null,
  );
  // Threads with a turn still running, so background threads get a dot.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  // Unread dots: last-seen time per thread (see loadSeenMap).
  const [seenAt, setSeenAt] = useState<Record<string, number>>(loadSeenMap);
  // First run on this device (no stored seen map): the first server sync
  // adopts every thread as read so history doesn't arrive covered in dots.
  const needsSeenSeedRef = useRef(Object.keys(seenAt).length === 0);
  // Whether the main column shows the chat or the manage panel. The sidebar
  // stays mounted either way; the URL is kept in sync via pushState so
  // /manage is linkable and back/forward work without remounting the app.
  const [view, setView] = useState<MainView>(initialView);
  // Web push opt-in for proactive notifications.
  const push = usePushNotifications();
  // Slash-command palette: built-ins plus skills saved from chat.
  const [commands, setCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS);
  // Model picker: catalog from the Vercel AI Gateway, selection persisted.
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>(loadSavedModel);

  useEffect(() => {
    void fetch("/api/models")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { models?: ModelOption[] } | null) => {
        if (!body?.models?.length) return;
        setModels(body.models);
        // A saved model that left the catalog would fail every turn; fall
        // back to the default rather than keep sending a stale id.
        setModel((current) => {
          if (body.models?.some((option) => option.id === current)) return current;
          try {
            localStorage.setItem(MODEL_KEY, DEFAULT_MODEL_ID);
          } catch {
            // Storage unavailable; the reset still applies for this session.
          }
          return DEFAULT_MODEL_ID;
        });
      })
      .catch(() => undefined);
  }, []);

  function selectModel(id: string) {
    setModel(id);
    try {
      localStorage.setItem(MODEL_KEY, id);
    } catch {
      // Storage unavailable; the selection still applies for this session.
    }
  }

  // Callbacks fired from ChatThread need the current meta, not the one
  // captured when the thread mounted.
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useEffect(() => {
    try {
      localStorage.setItem(THREADS_KEY, JSON.stringify(index));
    } catch {
      // Storage full or unavailable; sessions still live server-side.
    }
  }, [index]);

  useEffect(() => {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seenAt));
    } catch {
      // Storage full or unavailable; dots reset on reload at worst.
    }
  }, [seenAt]);

  // The open thread is always caught up: record its latest activity as seen.
  useEffect(() => {
    const active = index.threads.find((thread) => thread.id === index.activeId);
    if (!active) return;
    setSeenAt((prev) =>
      (prev[active.id] ?? 0) >= active.updatedAt ? prev : { ...prev, [active.id]: active.updatedAt },
    );
  }, [index]);

  // In production the session routes sit behind HTTP Basic auth. Probing a
  // protected route on load makes the browser show its login prompt up front
  // instead of on the first send.
  useEffect(() => {
    void fetch("/eve/v1/info").catch(() => undefined);
  }, []);

  // Extend the slash palette with skills the agent has saved (check_schedule
  // and friends), so they're one "/" away.
  useEffect(() => {
    void fetch("/api/commands")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { commands?: { name: string; description: string }[] } | null) => {
        if (!body?.commands?.length) return;
        const skillCommands: SlashCommand[] = body.commands
          .filter((skill) => !BUILTIN_COMMANDS.some((builtin) => builtin.name === skill.name))
          .map((skill) => ({
            name: skill.name,
            description: skill.description || "Saved skill",
            prompt: `Use your "${skill.name}" skill.`,
          }));
        setCommands([...BUILTIN_COMMANDS, ...skillCommands]);
      })
      .catch(() => undefined);
  }, []);

  // Pull the server's thread list on load: prefer the newer copy of each
  // thread, adopt threads created on other devices, and upload any threads
  // the server doesn't know about yet. Re-synced on focus and on a slow
  // interval so proactive threads (fired reminders) show up while the app
  // stays open.
  useEffect(() => {
    function syncServerThreads() {
      void fetchServerThreads().then((serverThreads) => {
        if (!serverThreads) return;
        const serverIds = new Set(serverThreads.map((thread) => thread.id));
        for (const thread of indexRef.current.threads) {
          if (serverIds.has(thread.id)) continue;
          const chat = loadSavedChat(thread.id);
          if (chat?.events?.length) putThreadToServer(thread, chat);
        }
        setIndex((prev) => {
          const byId = new Map<string, ThreadMeta>(
            serverThreads.map((thread) => [thread.id, thread]),
          );
          for (const thread of prev.threads) {
            const existing = byId.get(thread.id);
            if (!existing) byId.set(thread.id, thread);
            else if (thread.updatedAt > existing.updatedAt)
              // Local copy wins, but origin is server-authored: keep it.
              byId.set(thread.id, { ...thread, origin: thread.origin ?? existing.origin });
          }
          const threads = [...byId.values()];
          const activeId = threads.some((thread) => thread.id === prev.activeId)
            ? prev.activeId
            : [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
          return { activeId, threads };
        });
        // First run on this device: adopt everything as read so history
        // doesn't arrive covered in dots. After that, only new activity dots.
        if (needsSeenSeedRef.current) {
          needsSeenSeedRef.current = false;
          setSeenAt((prev) => {
            const seeded: Record<string, number> = {};
            for (const thread of serverThreads) seeded[thread.id] = thread.updatedAt;
            for (const thread of indexRef.current.threads) {
              seeded[thread.id] = Math.max(seeded[thread.id] ?? 0, thread.updatedAt);
            }
            return { ...seeded, ...prev };
          });
        }
      });
    }
    syncServerThreads();
    const timer = setInterval(syncServerThreads, 60_000);
    window.addEventListener("focus", syncServerThreads);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", syncServerThreads);
    };
  }, []);

  // Resolve the active thread's chat: localStorage first, then the server
  // (for threads that live on another device or after cleared storage).
  // Local hits resolve during render so switching threads never paints the
  // intermediate spinner frame.
  if (activeChat?.threadId !== index.activeId) {
    const local = loadSavedChat(index.activeId);
    if (local) setActiveChat({ threadId: index.activeId, chat: local });
  }
  // Fetch from the server when there's no local copy, or when the thread's
  // synced updatedAt says another device wrote after our local savedAt (the
  // local copy is stale). refreshedRef stops clock skew between devices from
  // refetching the same state forever.
  const refreshedRef = useRef<string | null>(null);
  useEffect(() => {
    const threadId = index.activeId;
    if (busyIds.has(threadId)) return; // never clobber a streaming turn
    const meta = index.threads.find((thread) => thread.id === threadId);
    const local = loadSavedChat(threadId);
    const stale = local !== null && meta !== undefined && (local.savedAt ?? 0) < meta.updatedAt;
    if (local && !stale) return;
    const refreshKey = `${threadId}:${meta?.updatedAt ?? 0}`;
    if (local && refreshedRef.current === refreshKey) return;
    let cancelled = false;
    void fetchServerChat(threadId).then((chat) => {
      if (cancelled) return;
      refreshedRef.current = refreshKey;
      if (local !== null && (chat?.events?.length ?? 0) <= (local.events?.length ?? 0)) {
        // The server copy isn't ahead of ours (often our own PUT still in
        // flight). Re-stamp the local copy as fresh so we stop probing.
        saveLocalChat(threadId, local);
        return;
      }
      if (chat) saveLocalChat(threadId, chat);
      setActiveChat((prev) => ({
        threadId,
        chat: chat ?? {},
        revision: prev?.threadId === threadId ? (prev.revision ?? 0) + 1 : 0,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [index, busyIds]);

  function persistChat(threadId: string, chat: SavedChat) {
    saveLocalChat(threadId, chat);
    const meta = indexRef.current.threads.find((thread) => thread.id === threadId);
    if (meta) putThreadToServer(meta, chat);
  }

  // Sidebar search: titles match locally; from two characters the server's
  // message-content search joins in (debounced).
  useEffect(() => {
    const needle = searchQuery.trim();
    if (needle.length < 2) {
      setContentMatchIds(new Set());
      return;
    }
    const timer = setTimeout(() => {
      void fetch(`/api/threads/search?q=${encodeURIComponent(needle)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { results?: { id: string }[] } | null) => {
          setContentMatchIds(new Set((body?.results ?? []).map((result) => result.id)));
        })
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Cmd+K / Ctrl+K opens the navigation palette.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Deep link from the /manage page: /?thread=<id> opens that thread. The
  // param is consumed once and stripped so reloads don't re-apply it.
  useEffect(() => {
    const url = new URL(window.location.href);
    const threadId = url.searchParams.get("thread");
    if (threadId === null) return;
    url.searchParams.delete("thread");
    window.history.replaceState(null, "", url.pathname + url.search);
    setIndex((prev) => ({ ...prev, activeId: threadId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/forward between "/" and "/manage" (we navigate with pushState so the
  // app, and especially the sidebar, never remounts).
  useEffect(() => {
    function onPopState() {
      setView(window.location.pathname === "/manage" ? "manage" : "chat");
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const sections = sectionThreads(index.threads, searchQuery, contentMatchIds);

  function showView(next: MainView) {
    setView(next);
    const path = next === "manage" ? "/manage" : "/";
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
  }

  function newThread() {
    const meta = newThreadMeta();
    // Seed the local chat so the new thread renders without a server probe.
    saveLocalChat(meta.id, {});
    setPendingDraft(null);
    setIndex((prev) => ({ activeId: meta.id, threads: [meta, ...prev.threads] }));
    setSidebarOpen(false);
    showView("chat");
  }

  function selectThread(id: string) {
    setPendingDraft(null);
    setIndex((prev) => ({ ...prev, activeId: id }));
    setSidebarOpen(false);
    showView("chat");
  }

  /** New thread seeded with history sliced from the active one (fork). */
  function forkThread(chat: SavedChat, draft?: string) {
    const source = indexRef.current.threads.find(
      (thread) => thread.id === indexRef.current.activeId,
    );
    const meta: ThreadMeta = {
      ...newThreadMeta(),
      title: source ? `Fork: ${source.title}`.slice(0, 80) : "Forked thread",
      // Protect the fork title from the auto-titling backfill.
      renamed: true,
    };
    const saved: SavedChat = { ...chat, savedAt: Date.now() };
    saveLocalChat(meta.id, saved);
    putThreadToServer(meta, saved);
    setPendingDraft(draft !== undefined ? { threadId: meta.id, text: draft } : null);
    setIndex((prev) => ({ activeId: meta.id, threads: [meta, ...prev.threads] }));
    setSidebarOpen(false);
  }

  function deleteThread(id: string) {
    try {
      localStorage.removeItem(chatKey(id));
    } catch {
      // Ignore storage failures.
    }
    deleteThreadOnServer(id);
    setIndex((prev) => {
      const remaining = prev.threads.filter((thread) => thread.id !== id);
      if (remaining.length === 0) {
        const meta = newThreadMeta();
        return { activeId: meta.id, threads: [meta] };
      }
      const activeId =
        prev.activeId === id
          ? [...remaining].sort((a, b) => b.updatedAt - a.updatedAt)[0].id
          : prev.activeId;
      return { activeId, threads: remaining };
    });
  }

  function setThreadTitle(id: string, title: string) {
    setIndex((prev) => ({
      ...prev,
      threads: prev.threads.map((thread) =>
        thread.id === id && !thread.renamed && thread.title !== title
          ? { ...thread, title }
          : thread,
      ),
    }));
  }

  function touchThread(id: string, title?: string) {
    setIndex((prev) => ({
      ...prev,
      threads: prev.threads.map((thread) =>
        thread.id === id
          ? {
              ...thread,
              updatedAt: Date.now(),
              ...(title && !thread.renamed ? { title } : {}),
            }
          : thread,
      ),
    }));
  }

  function renameThread(id: string, rawTitle: string) {
    setEditingId(null);
    const current = indexRef.current.threads.find((thread) => thread.id === id);
    const title = rawTitle.replaceAll("\n", " ").trim().slice(0, 80);
    if (!current || title.length === 0 || title === current.title) return;
    // updatedAt stays put: renaming shouldn't move a thread between date groups.
    const meta: ThreadMeta = { ...current, title, renamed: true };
    setIndex((prev) => ({
      ...prev,
      threads: prev.threads.map((thread) => (thread.id === id ? meta : thread)),
    }));
    putThreadMetaToServer(meta);
  }

  function togglePin(id: string) {
    const current = indexRef.current.threads.find((thread) => thread.id === id);
    if (!current) return;
    // updatedAt stays put so unpinning returns the thread to its real spot.
    const meta: ThreadMeta = { ...current, pinned: !current.pinned };
    setIndex((prev) => ({
      ...prev,
      threads: prev.threads.map((thread) => (thread.id === id ? meta : thread)),
    }));
    putThreadMetaToServer(meta);
  }

  function setThreadBusy(id: string, busy: boolean) {
    setBusyIds((prev) => {
      if (prev.has(id) === busy) return prev;
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <div className="flex h-dvh w-full">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          aria-hidden
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-40 flex w-64 shrink-0 -translate-x-full flex-col border-e border-gray-a4 bg-gray-2 transition-transform duration-200 md:static md:translate-x-0",
          sidebarOpen && "translate-x-0",
        )}
      >
        <div className="flex items-center justify-between px-3 py-2.5">
          <button
            type="button"
            className="rounded-sm text-sm font-semibold hover:text-gray-12"
            aria-label="Back to chat"
            title="Back to chat"
            onClick={() => showView("chat")}
          >
            Eve
          </button>
          <div className="flex items-center">
            {push.status !== "unsupported" && push.status !== "loading" && (
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={push.status === "on" ? BellIcon : BellSlashIcon}
                aria-label={
                  push.status === "on" ? "Disable notifications" : "Enable notifications"
                }
                title={
                  push.status === "on"
                    ? "Notifications on - click to disable"
                    : push.status === "denied"
                      ? "Notifications blocked in browser settings"
                      : "Enable notifications"
                }
                className={cn(push.status !== "on" && "text-gray-11")}
                onClick={push.toggle}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={GearSixIcon}
              aria-label="Manage"
              aria-pressed={view === "manage"}
              title="Manage: reminders, triggers, memory, connections, skills"
              className={cn(view === "manage" && "bg-gray-a3 text-gray-12")}
              onClick={() => showView(view === "manage" ? "chat" : "manage")}
            />
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={PlusIcon}
              aria-label="New thread"
              title="New thread"
              onClick={newThread}
            />
          </div>
        </div>
        <div className="px-2 pb-2">
          <div className="relative">
            <TextField.Input
              size="2"
              value={searchQuery}
              placeholder="Search threads"
              aria-label="Search threads"
              className="w-full"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            {searchQuery.length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute end-1.5 top-1/2 -translate-y-1/2 text-gray-11 hover:text-gray-12"
                onClick={() => setSearchQuery("")}
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {sections.every((section) => section.threads.length === 0) && (
            <p className="px-2.5 py-2 text-xs text-gray-11">No threads match.</p>
          )}
          {sections.map((section) => (
            <div key={section.label ?? "results"} className="pb-2">
              {section.label && (
                <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-gray-11">
                  {section.label}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
                {section.threads.map((thread) => (
                  <SidebarThread
                    key={thread.id}
                    thread={thread}
                    // The active-thread highlight and the gear highlight are
                    // mutually exclusive: on the manage view the gear owns it.
                    active={view === "chat" && thread.id === index.activeId}
                    busy={busyIds.has(thread.id)}
                    unread={
                      thread.id !== index.activeId &&
                      // Before the first-sync seeding, nothing is unread; after
                      // it, a thread with no seen entry is a new arrival.
                      Object.keys(seenAt).length > 0 &&
                      thread.updatedAt > (seenAt[thread.id] ?? 0)
                    }
                    editing={editingId === thread.id}
                    onSelect={() => selectThread(thread.id)}
                    onStartRename={() => setEditingId(thread.id)}
                    onRename={(title) => renameThread(thread.id, title)}
                    onCancelRename={() => setEditingId(null)}
                    onTogglePin={() => togglePin(thread.id)}
                    onDelete={() => {
                      setThreadToDelete(thread);
                      setDeleteDialogOpen(true);
                    }}
                  />
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      {view === "manage" ? (
        <main className="relative h-dvh min-w-0 flex-1 overflow-y-auto">
          {/* Wrapper owns md:hidden — Button's display styles can override a class on the button itself. */}
          <div className="absolute start-2 top-2 z-20 md:hidden">
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={SidebarSimpleIcon}
              aria-label="Open threads"
              onClick={() => setSidebarOpen(true)}
            />
          </div>
          <div className="w-full max-w-3xl px-6 py-6">
            <header className="mb-5">
              <h1 className="text-lg font-semibold">Manage</h1>
              <p className="text-sm text-gray-11">
                What Eve does and knows on her own. Create reminders, triggers, and skills by
                asking in chat.
              </p>
            </header>
            <ManagePanel onOpenThread={selectThread} />
          </div>
        </main>
      ) : activeChat && activeChat.threadId === index.activeId ? (
        <ChatThread
          key={`${index.activeId}:${activeChat.revision ?? 0}`}
          threadId={index.activeId}
          initialChat={activeChat.chat}
          initialDraft={
            pendingDraft?.threadId === index.activeId ? pendingDraft.text : undefined
          }
          onTitle={(title) => setThreadTitle(index.activeId, title)}
          onActivity={(title) => touchThread(index.activeId, title)}
          onPersist={(chat) => persistChat(index.activeId, chat)}
          onBusyChange={(busy) => setThreadBusy(index.activeId, busy)}
          onOpenSidebar={() => setSidebarOpen(true)}
          onFork={forkThread}
          commands={commands}
          model={model}
          models={models}
          onModelChange={selectModel}
        />
      ) : (
        <main className="flex h-dvh min-w-0 flex-1 items-center justify-center text-gray-11">
          <Loader size={20} />
        </main>
      )}

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        threads={[...index.threads]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((thread) => ({ id: thread.id, title: thread.title, updatedAt: thread.updatedAt }))}
        onSelectThread={selectThread}
        onNewChat={newThread}
        onOpenManage={() => showView("manage")}
        pushStatus={push.status}
        onTogglePush={push.toggle}
      />

      <Dialog.Root open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <Dialog.Content className="p-6">
          <Dialog.Title>Delete thread?</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-gray-11">
            &ldquo;{threadToDelete?.title}&rdquo; and its local history will be removed. This
            can&rsquo;t be undone.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (threadToDelete) deleteThread(threadToDelete.id);
                setDeleteDialogOpen(false);
              }}
            >
              Delete
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}

function SidebarThread({
  thread,
  active,
  busy,
  unread,
  editing,
  onSelect,
  onStartRename,
  onRename,
  onCancelRename,
  onTogglePin,
  onDelete,
}: {
  thread: ThreadMeta;
  active: boolean;
  busy: boolean;
  unread: boolean;
  editing: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  // Escape should cancel, not commit; the flag stops the blur commit that
  // follows when the input unmounts.
  const cancelledRef = useRef(false);

  if (editing) {
    return (
      <li>
        <input
          autoFocus
          defaultValue={thread.title}
          aria-label="Thread title"
          className="w-full rounded-md bg-panel px-2.5 py-2 text-sm text-gray-12 ring ring-accent-8 outline-none"
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onRename(event.currentTarget.value);
            } else if (event.key === "Escape") {
              cancelledRef.current = true;
              onCancelRename();
            }
          }}
          onBlur={(event) => {
            if (cancelledRef.current) {
              cancelledRef.current = false;
              return;
            }
            onRename(event.currentTarget.value);
          }}
        />
      </li>
    );
  }

  return (
    <li className="group/thread relative">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          // ps-4 leaves room for the busy/unread dot, which hangs to the
          // start of the title and would otherwise clip at the sidebar edge.
          "w-full rounded-md py-1.5 pe-8 ps-4 text-start group-hover/thread:bg-gray-a3",
          active && "bg-gray-a3 text-gray-12",
        )}
      >
        <span className="relative flex items-center">
          {(busy || unread) && (
            <span
              className={cn(
                "absolute -start-1 size-1.5 shrink-0 -translate-x-full rounded-full bg-accent-9 rtl:translate-x-full",
                busy && "animate-pulse",
              )}
              role="status"
              aria-label={busy ? "Turn in progress" : "Unread activity"}
            />
          )}
          <span className={cn("truncate text-sm", unread && "font-medium text-gray-12")}>
            {thread.title}
          </span>
          {thread.origin === "reminder" && (
            <AlarmIcon
              className="ms-1.5 size-3 shrink-0 text-gray-11"
              aria-label="Started by a reminder"
            />
          )}
          {thread.origin === "webhook" && (
            <LightningIcon
              className="ms-1.5 size-3 shrink-0 text-gray-11"
              aria-label="Started by a webhook"
            />
          )}
        </span>
        <span className="block text-xs text-gray-11">
          {formatThreadDate(thread.updatedAt)}
        </span>
      </button>
      <div className="absolute end-1 top-1/2 flex -translate-y-1/2 items-center rounded-md bg-gray-a3 opacity-0 focus-within:opacity-100 group-hover/thread:opacity-100">
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={thread.pinned ? PushPinSlashIcon : PushPinIcon}
          aria-label={thread.pinned ? `Unpin ${thread.title}` : `Pin ${thread.title}`}
          onClick={onTogglePin}
        />
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={PencilSimpleIcon}
          aria-label={`Rename ${thread.title}`}
          onClick={onStartRename}
        />
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={TrashIcon}
          aria-label={`Delete ${thread.title}`}
          onClick={onDelete}
        />
      </div>
    </li>
  );
}

function ChatThread({
  threadId: _threadId,
  initialChat,
  initialDraft,
  onTitle,
  onActivity,
  onPersist,
  onBusyChange,
  onOpenSidebar,
  onFork,
  commands,
  model,
  models,
  onModelChange,
}: {
  threadId: string;
  initialChat: SavedChat;
  /** Composer prefill, used when a fork was started from an edit. */
  initialDraft?: string;
  onTitle: (title: string) => void;
  onActivity: (title?: string) => void;
  onPersist: (chat: SavedChat) => void;
  onBusyChange: (busy: boolean) => void;
  onOpenSidebar: () => void;
  /** Creates a new thread seeded with `chat`, optionally prefilling the composer. */
  onFork: (chat: SavedChat, draft?: string) => void;
  commands: SlashCommand[];
  model: string;
  models: ModelOption[];
  onModelChange: (id: string) => void;
}) {
  const [draft, setDraft] = useState(initialDraft ?? "");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // One-turn transcript context for threads forked from a message: eve
  // sessions are append-only, so the fork starts a fresh session and this
  // rides along on its first send only.
  const forkContextRef = useRef(initialChat.forkContext);

  // Attachments staged in the composer, sent with the next message.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child; count to avoid overlay flicker.
  const dragDepth = useRef(0);

  // Slash-command palette state.
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);

  // Voice input.
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speechSupported = useMemo(() => getSpeechRecognition() !== null, []);

  const agent = useEveAgent({
    initialEvents: initialChat.events ?? [],
    initialSession: initialChat.session,
    // Ride the selected gateway model along with every turn; the agent's
    // dynamic model resolver reads it from the turn's client context. Forked
    // threads also carry their source transcript on the first turn.
    prepareSend: (input) => {
      const forkedThreadTranscript = forkContextRef.current;
      forkContextRef.current = undefined;
      return {
        ...input,
        clientContext: {
          eveWebModel: model,
          ...(forkedThreadTranscript !== undefined ? { forkedThreadTranscript } : {}),
        },
      };
    },
    onFinish(snapshot) {
      onPersist({ events: snapshot.events, session: snapshot.session });
      onActivity();
    },
  });

  // Continuously persist while a turn streams (debounced), so a reload
  // mid-turn doesn't lose the conversation. onFinish does the final save.
  const initialEventCount = useRef(initialChat.events?.length ?? 0);
  useEffect(() => {
    if (agent.events.length <= initialEventCount.current) return;
    const timer = setTimeout(() => {
      onPersist({ events: agent.events, session: agent.session });
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.events, agent.session]);

  // Backfill titles for threads restored from storage (e.g. the migrated
  // pre-threads chat) whose meta still has the placeholder title.
  useEffect(() => {
    const title = deriveTitle(agent.data.messages);
    if (title) onTitle(title);
    // Intentionally run once per mounted thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  // Report turn activity up so the sidebar can dot busy threads. Deliberately
  // not cleared on unmount: a turn keeps running server-side when the user
  // switches threads, and revisiting the thread resolves the real status.
  useEffect(() => {
    onBusyChange(isBusy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy]);

  // Per-turn cost/token totals from step.completed events, keyed by turnId so
  // each assistant reply can show what it cost.
  const usageByTurn = useMemo(() => {
    const map = new Map<string, TurnUsage>();
    for (const event of agent.events) {
      if (event.type !== "step.completed") continue;
      const usage = event.data.usage;
      if (!usage) continue;
      const entry = map.get(event.data.turnId) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 };
      entry.costUsd += usage.costUsd ?? 0;
      entry.inputTokens += usage.inputTokens ?? 0;
      entry.outputTokens += usage.outputTokens ?? 0;
      map.set(event.data.turnId, entry);
    }
    return map;
  }, [agent.events]);

  const threadUsage = useMemo(() => {
    const total: TurnUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    for (const usage of usageByTurn.values()) {
      total.costUsd += usage.costUsd;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
    }
    return total;
  }, [usageByTurn]);

  async function addFiles(files: Iterable<File>) {
    const additions: PendingAttachment[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) continue;
      try {
        additions.push({
          id: crypto.randomUUID(),
          name: file.name || "pasted-file",
          mediaType: file.type || "application/octet-stream",
          size: file.size,
          dataUrl: await readFileAsDataUrl(file),
        });
      } catch {
        // Unreadable file (e.g. a dragged folder); skip it.
      }
    }
    if (additions.length > 0) {
      setAttachments((prev) => [...prev, ...additions]);
      composerRef.current?.focus();
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }

  // The palette opens while the draft is a single line starting with "/".
  const paletteQuery =
    draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1) : null;
  const paletteCommands =
    paletteQuery !== null && !paletteDismissed ? filterCommands(commands, paletteQuery) : [];
  const paletteOpen = paletteCommands.length > 0;
  const activePaletteIndex = Math.min(paletteIndex, paletteCommands.length - 1);

  function applyCommand(command: SlashCommand) {
    setDraft(command.prompt);
    setPaletteIndex(0);
    composerRef.current?.focus();
  }

  function toggleVoice() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = getSpeechRecognition();
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) transcript += result[0].transcript;
      }
      const text = transcript.trim();
      if (text.length === 0) return;
      setDraft((prev) => (prev.trim().length > 0 ? `${prev.trimEnd()} ${text}` : text));
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  // Stop the microphone if the user switches threads mid-dictation.
  useEffect(() => {
    return () => recognitionRef.current?.stop();
  }, []);

  function sendDraft() {
    const text = draft.trim();
    if ((text.length === 0 && attachments.length === 0) || isBusy) return;
    const staged = attachments;
    setDraft("");
    setAttachments([]);
    recognitionRef.current?.stop();
    const titleSource = text.length > 0 ? text : (staged[0]?.name ?? "Attachment");
    onActivity(agent.data.messages.length === 0 ? toThreadTitle(titleSource) : undefined);
    if (staged.length === 0) {
      void agent.send({ message: text });
      return;
    }
    const message: UserContent = [
      ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
      ...staged.map((attachment) => ({
        type: "file" as const,
        data: attachment.dataUrl,
        mediaType: attachment.mediaType,
        filename: attachment.name,
      })),
    ];
    void agent.send({ message });
  }

  async function stopTurn() {
    const sessionId = agent.session?.sessionId;
    agent.stop();
    if (sessionId) {
      await fetch(`/eve/v1/session/${sessionId}/cancel`, { method: "POST" }).catch(() => undefined);
    }
  }

  function respondToInput(requestId: string, optionId: string) {
    void agent.send({ inputResponses: [{ requestId, optionId }] });
  }

  function editMessage(text: string) {
    setDraft(text);
    composerRef.current?.focus();
  }

  function retryMessage(text: string) {
    if (isBusy || text.length === 0) return;
    onActivity();
    void agent.send({ message: text });
  }

  /** Re-asks the last user message on the same session (fresh reply, and a
   * different model if one was just picked). */
  function regenerateLastReply() {
    const lastUser = agent.data.messages.findLast((message) => message.role === "user");
    if (!lastUser) return;
    retryMessage(messageText(lastUser));
  }

  /** Plain-text transcript of `messages` for the fork's client context. */
  function buildTranscript(messages: readonly EveMessage[]): string | undefined {
    const lines = messages
      .map((message) => {
        const text = messageText(message);
        return text.length > 0 ? `${message.role === "user" ? "Micky" : "Eve"}: ${text}` : null;
      })
      .filter((line): line is string => line !== null);
    if (lines.length === 0) return undefined;
    const transcript = lines.join("\n\n");
    // Keep the context message bounded; the tail is the relevant part.
    return transcript.length > 8000 ? `…${transcript.slice(-8000)}` : transcript;
  }

  /**
   * Starts a new thread carrying history up to `message`. eve sessions are
   * append-only, so the fork replays the sliced event log for display and
   * starts a fresh session; `buildTranscript` output rides the first send so
   * the agent knows the carried history.
   *
   * `includeTurn` keeps the whole turn containing the message (fork from an
   * assistant reply); without it history stops before that turn (edit &
   * resend of a user message, whose old reply shouldn't come along).
   */
  function forkFromMessage(message: EveMessage, includeTurn: boolean, draftText?: string) {
    const turnId = message.metadata?.turnId;
    const events = agent.events;
    let sliced: readonly HandleMessageStreamEvent[] = events;
    if (turnId !== undefined) {
      const matches = (event: HandleMessageStreamEvent) =>
        "data" in event &&
        (event.data as { turnId?: string } | undefined)?.turnId === turnId;
      if (includeTurn) {
        const last = events.findLastIndex(matches);
        if (last >= 0) sliced = events.slice(0, last + 1);
      } else {
        const first = events.findIndex(matches);
        sliced = first >= 0 ? events.slice(0, first) : events;
      }
    }

    const messageIndex = agent.data.messages.findIndex((entry) => entry.id === message.id);
    const carried =
      messageIndex >= 0
        ? agent.data.messages.slice(0, includeTurn ? messageIndex + 1 : messageIndex)
        : agent.data.messages;

    onFork({ events: sliced, forkContext: buildTranscript(carried) }, draftText);
  }

  const hasMessages = agent.data.messages.length > 0;
  const lastUserId = agent.data.messages.findLast((message) => message.role === "user")?.id;
  const lastAssistantId = agent.data.messages.findLast(
    (message) => message.role === "assistant",
  )?.id;
  // Keep the thinking indicator up until the reply has something to show;
  // reasoning models can stream for a while before any visible output.
  const lastMessage = agent.data.messages.at(-1);
  const showThinking =
    isBusy && (lastMessage?.role !== "assistant" || !hasVisibleParts(lastMessage));

  return (
    <main
      className="relative flex h-dvh min-w-0 flex-1 flex-col"
      onDragEnter={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void addFiles(event.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-canvas/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-xl border-2 border-dashed border-gray-a4 px-8 py-6 text-sm font-medium">
            <PaperclipIcon className="size-4" />
            Drop files to attach
          </div>
        </div>
      )}
      <div className="mx-auto flex size-full max-w-3xl min-h-0 flex-col px-4">
        {/* Wrapper owns md:hidden — Button's display styles can override a class on the button itself. */}
        <div className="absolute start-2 top-2 z-20 md:hidden">
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={SidebarSimpleIcon}
            aria-label="Open threads"
            onClick={onOpenSidebar}
          />
        </div>

        <MessageScrollerProvider autoScroll>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport className="[scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
              <MessageScrollerContent className="gap-5 py-6">
                {!hasMessages && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                    <h2 className="text-lg font-semibold text-gray-12">Hey Micky</h2>
                    <p className="max-w-sm text-sm text-gray-11">
                      Ask me anything — I have your memory, a browser, and all your connected apps.
                    </p>
                  </div>
                )}
                {agent.data.messages.map((message, index) => (
                  // Key by position, not message.id: the id of an optimistic
                  // user message changes once the server echoes it, and a key
                  // change remounts the item (a visible flash with
                  // content-visibility: auto).
                  <MessageScrollerItem key={`${message.role}-${index}`} messageId={`${message.role}-${index}`}>
                    <ChatMessage
                      message={message}
                      usage={
                        message.metadata?.turnId
                          ? usageByTurn.get(message.metadata.turnId)
                          : undefined
                      }
                      busy={isBusy}
                      isLastUser={message.id === lastUserId}
                      isLastAssistant={message.id === lastAssistantId}
                      onEdit={editMessage}
                      onRetry={retryMessage}
                      onRegenerate={regenerateLastReply}
                      onFork={forkFromMessage}
                      onRespond={respondToInput}
                    />
                  </MessageScrollerItem>
                ))}
                {showThinking && (
                  <MessageScrollerItem messageId="thinking">
                    <Marker role="status">
                      <MarkerIcon>
                        <Loader size={14} />
                      </MarkerIcon>
                      <MarkerContent className="shimmer">Thinking...</MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                )}
                {agent.error && (
                  <MessageScrollerItem messageId="error">
                    <Bubble variant="destructive">
                      <BubbleContent>{agent.error.message}</BubbleContent>
                    </Bubble>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        <footer className="relative pb-4 pt-2">
          {paletteOpen && (
            <div
              role="listbox"
              aria-label="Commands"
              className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded-lg bg-panel shadow-lg ring ring-gray-a6"
            >
              <p className="px-3 pt-2 pb-1 text-[11px] font-medium text-gray-11">
                Commands
              </p>
              <div className="max-h-64 overflow-y-auto pb-1">
                {paletteCommands.map((command, commandIndex) => (
                  <button
                    key={command.name}
                    type="button"
                    role="option"
                    aria-selected={commandIndex === activePaletteIndex}
                    className={cn(
                      "flex w-full items-baseline gap-2 px-3 py-2 text-start text-sm",
                      commandIndex === activePaletteIndex && "bg-gray-a3 text-gray-12",
                    )}
                    // Keep the textarea focused; the click still fires.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setPaletteIndex(commandIndex)}
                    onClick={() => applyCommand(command)}
                  >
                    <span className="shrink-0 font-mono text-xs font-medium">/{command.name}</span>
                    <span className="truncate text-xs text-gray-11">
                      {command.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <form
            className="rounded-xl bg-panel p-2 ring ring-gray-a4 focus-within:ring-accent-8/40"
            onSubmit={(event) => {
              event.preventDefault();
              sendDraft();
            }}
          >
            {attachments.length > 0 && (
              <AttachmentGroup className="px-1 pb-2">
                {attachments.map((attachment) => (
                  <Attachment key={attachment.id} size="sm">
                    <AttachmentMedia
                      variant={attachment.mediaType.startsWith("image/") ? "image" : "icon"}
                    >
                      {attachment.mediaType.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={attachment.dataUrl} alt={attachment.name} />
                      ) : (
                        <FileIcon />
                      )}
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>{attachment.name}</AttachmentTitle>
                      <AttachmentDescription>
                        {formatBytes(attachment.size)}
                      </AttachmentDescription>
                    </AttachmentContent>
                    <AttachmentActions>
                      <AttachmentAction
                        aria-label={`Remove ${attachment.name}`}
                        icon={XIcon}
                        onClick={() => removeAttachment(attachment.id)}
                      />
                    </AttachmentActions>
                  </Attachment>
                ))}
              </AttachmentGroup>
            )}
            <textarea
              ref={composerRef}
              value={draft}
              aria-label="Message Eve"
              placeholder="Message Eve... (/ for commands)"
              rows={1}
              className="field-sizing-content max-h-44 w-full resize-none rounded-none bg-transparent px-1 text-sm outline-none placeholder:text-gray-a9"
              onChange={(event) => {
                setDraft(event.target.value);
                setPaletteDismissed(false);
              }}
              onPaste={(event) => {
                if (event.clipboardData.files.length === 0) return;
                event.preventDefault();
                void addFiles(event.clipboardData.files);
              }}
              onKeyDown={(event) => {
                if (paletteOpen) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setPaletteIndex((activePaletteIndex + 1) % paletteCommands.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setPaletteIndex(
                      (activePaletteIndex - 1 + paletteCommands.length) %
                        paletteCommands.length,
                    );
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    applyCommand(paletteCommands[activePaletteIndex]);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setPaletteDismissed(true);
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendDraft();
                }
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div className="mt-1 flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                shape="square"
                icon={PlusIcon}
                aria-label="Attach files"
                title="Attach files"
                className="text-gray-11"
                onClick={() => fileInputRef.current?.click()}
              />
              <div className="ms-auto flex items-center gap-1">
                <ModelPicker model={model} models={models} onSelect={onModelChange} />
                {speechSupported && (
                  <Button
                    type="button"
                    variant="ghost"
                    shape="circle"
                    icon={
                      listening ? <MicrophoneIcon weight="fill" /> : <MicrophoneIcon />
                    }
                    aria-label={listening ? "Stop voice input" : "Start voice input"}
                    title={listening ? "Stop voice input" : "Start voice input"}
                    className={cn(
                      "text-gray-11",
                      listening && "animate-pulse !text-danger-11",
                    )}
                    onClick={toggleVoice}
                  />
                )}
                {isBusy ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="circle"
                    icon={<StopIcon weight="fill" />}
                    aria-label="Stop"
                    onClick={() => void stopTurn()}
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="circle"
                    icon={ArrowUpIcon}
                    aria-label="Send"
                    disabled={draft.trim().length === 0 && attachments.length === 0}
                  />
                )}
              </div>
            </div>
          </form>
          <p className="h-6 pt-2 text-center text-[11px] text-gray-11">
            {threadUsage.inputTokens > 0 ? `${formatUsage(threadUsage)} this thread` : "\u00A0"}
          </p>
        </footer>
      </div>
    </main>
  );
}

/**
 * Provider mark rendered from the models.dev logo set. The SVGs are drawn
 * with `fill="currentColor"`, which an <img> would rasterize as black, so
 * the logo is applied as a CSS mask over the button's text color instead.
 * A hidden <img> probes availability; unknown providers fall back to their
 * two-letter initials.
 */
function ProviderLogo({ provider }: { provider: string }) {
  const [failed, setFailed] = useState(false);
  const src = `https://models.dev/logos/${encodeURIComponent(provider)}.svg`;
  if (failed) return <>{provider.slice(0, 2)}</>;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" hidden onError={() => setFailed(true)} />
      <span
        aria-hidden
        className="size-4 bg-current [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]"
        style={{ maskImage: `url(${src})` }}
      />
    </>
  );
}

function ModelPicker({
  model,
  models,
  onSelect,
}: {
  model: string;
  models: ModelOption[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // null shows every provider; "favorites" narrows to starred models.
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>(loadModelFavorites);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking anywhere outside the picker.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function toggleFavorite(id: string) {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id];
      try {
        localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable; favorites still apply for this session.
      }
      return next;
    });
  }

  const providers = [...new Set(models.map((option) => modelProvider(option.id)))].sort();
  const needle = query.trim().toLowerCase();
  const filtered = models.filter((option) => {
    if (providerFilter === "favorites" && !favorites.includes(option.id)) return false;
    if (
      providerFilter !== null &&
      providerFilter !== "favorites" &&
      modelProvider(option.id) !== providerFilter
    )
      return false;
    return (
      needle.length === 0 ||
      option.id.toLowerCase().includes(needle) ||
      option.name.toLowerCase().includes(needle)
    );
  });
  const label = models.find((option) => option.id === model)?.name ?? model.split("/").pop() ?? model;

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        aria-label="Select model"
        aria-expanded={open}
        className="max-w-40 text-gray-11 hover:text-gray-12"
        onClick={() => {
          setOpen((prev) => !prev);
          setQuery("");
        }}
      >
        <span className="truncate">{label}</span>
        <CaretDownIcon className="size-3 shrink-0" />
      </Button>
      {open && (
        <div className="absolute bottom-full end-0 z-30 mb-2 flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl bg-panel shadow-lg ring ring-gray-a6">
          <div className="flex items-center gap-2 border-b border-gray-a4 px-3 py-2">
            <MagnifyingGlassIcon className="size-4 shrink-0 text-gray-11" />
            <input
              autoFocus
              value={query}
              placeholder="Search models..."
              aria-label="Search models"
              className="w-full bg-transparent text-sm outline-none placeholder:text-gray-a9"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
            />
          </div>
          <div className="flex min-h-0">
            <div
              role="tablist"
              aria-label="Filter by provider"
              className="flex max-h-80 w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-e border-gray-a4 p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <button
                type="button"
                role="tab"
                aria-selected={providerFilter === "favorites"}
                aria-label="Favorites"
                title="Favorites"
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg text-gray-11 transition-colors hover:bg-gray-a3 hover:text-gray-12",
                  providerFilter === "favorites" && "bg-gray-a3 text-gray-12",
                )}
                onClick={() =>
                  setProviderFilter((prev) => (prev === "favorites" ? null : "favorites"))
                }
              >
                <StarIcon className="size-4" />
              </button>
              {providers.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  role="tab"
                  aria-selected={providerFilter === provider}
                  aria-label={provider}
                  title={provider}
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold uppercase text-gray-11 transition-colors hover:bg-gray-a3 hover:text-gray-12",
                    providerFilter === provider && "bg-gray-a3 text-gray-12",
                  )}
                  onClick={() =>
                    setProviderFilter((prev) => (prev === provider ? null : provider))
                  }
                >
                  <ProviderLogo provider={provider} />
                </button>
              ))}
            </div>
            <div
              role="listbox"
              aria-label="Models"
              className="max-h-80 min-w-0 flex-1 overflow-y-auto p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {filtered.length === 0 && (
                <p className="px-2 py-2 text-xs text-gray-11">
                  {models.length === 0
                    ? "Model list unavailable."
                    : providerFilter === "favorites" && favorites.length === 0
                      ? "No favorites yet. Star a model to pin it here."
                      : "No models match."}
                </p>
              )}
              {filtered.map((option) => {
                const tier = priceTier(option.pricing);
                const starred = favorites.includes(option.id);
                return (
                  <div
                    key={option.id}
                    className="group/model relative rounded-lg transition-colors hover:bg-gray-a3"
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={option.id === model}
                      className="w-full px-2 py-1.5 pe-14 text-start"
                      onClick={() => {
                        onSelect(option.id);
                        setOpen(false);
                      }}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{option.name}</span>
                        {tier && (
                          <span className="shrink-0 text-[11px] text-gray-11">{tier}</span>
                        )}
                        {option.id === model && <CheckIcon className="size-3.5 shrink-0" />}
                      </span>
                      <span className="block truncate text-xs text-gray-11">
                        {option.description || option.id}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={starred ? `Unfavorite ${option.name}` : `Favorite ${option.name}`}
                      aria-pressed={starred}
                      className={cn(
                        "absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 transition-opacity",
                        starred
                          ? "text-yellow-500 hover:text-yellow-500"
                          : "text-gray-8 hover:text-gray-12",
                      )}
                      onClick={() => toggleFavorite(option.id)}
                    >
                      <StarIcon className="size-4" weight={starred ? "fill" : "regular"} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChatMessage({
  message,
  usage,
  busy,
  isLastUser,
  isLastAssistant,
  onEdit,
  onRetry,
  onRegenerate,
  onFork,
  onRespond,
}: {
  message: EveMessage;
  usage?: TurnUsage;
  busy: boolean;
  isLastUser: boolean;
  isLastAssistant: boolean;
  onEdit: (text: string) => void;
  onRetry: (text: string) => void;
  onRegenerate: () => void;
  onFork: (message: EveMessage, includeTurn: boolean, draft?: string) => void;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  const align = message.role === "user" ? "end" : "start";
  const text = messageText(message);
  const assistantDone =
    message.role === "assistant" && message.metadata?.status !== "streaming";
  const actionRowClass =
    "flex items-center gap-1 opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100";
  return (
    <Message align={align}>
      <MessageContent className="gap-2">
        {message.parts.map((part, index) => (
          <ChatPart key={index} part={part} role={message.role} onRespond={onRespond} />
        ))}
        {message.role === "assistant" && text.length > 0 && (
          <div className={cn(actionRowClass, !assistantDone && "invisible")}>
            <CopyButton text={text} />
            {isLastAssistant && !busy && (
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={ArrowClockwiseIcon}
                aria-label="Regenerate reply"
                title="Regenerate (re-asks with the currently selected model)"
                className="text-gray-11"
                onClick={onRegenerate}
              />
            )}
            {!busy && (
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={GitBranchIcon}
                aria-label="Fork thread from here"
                title="Fork thread from here"
                className="text-gray-11"
                onClick={() => onFork(message, true)}
              />
            )}
            {usage && (
              <span className="text-[11px] text-gray-11">{formatUsage(usage)}</span>
            )}
          </div>
        )}
        {message.role === "user" && text.length > 0 && (
          <div className={cn(actionRowClass, "justify-end", busy && "invisible")}>
            <CopyButton text={text} />
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              icon={PencilSimpleIcon}
              aria-label="Edit and resend"
              title={
                isLastUser
                  ? "Edit and resend"
                  : "Edit and resend from here (forks into a new thread)"
              }
              className="text-gray-11"
              onClick={() => {
                // Editing the last message just refills the composer; editing
                // an earlier one forks, since sessions are append-only and the
                // messages after it shouldn't come along.
                if (isLastUser) onEdit(text);
                else onFork(message, false, text);
              }}
            />
            {isLastUser && (
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={ArrowClockwiseIcon}
                aria-label="Retry"
                className="text-gray-11"
                onClick={() => onRetry(text)}
              />
            )}
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

function ChatPart({
  part,
  role,
  onRespond,
}: {
  part: EveMessagePart;
  role: "assistant" | "user";
  onRespond: (requestId: string, optionId: string) => void;
}) {
  switch (part.type) {
    case "text": {
      if (part.text.length === 0) return null;
      if (role === "user") {
        return (
          <Bubble align="end">
            <BubbleContent className="whitespace-pre-wrap">{part.text}</BubbleContent>
          </Bubble>
        );
      }
      return (
        <Bubble variant="ghost">
          <BubbleContent>
            <Markdown>{part.text}</Markdown>
          </BubbleContent>
        </Bubble>
      );
    }

    case "reasoning":
      if (part.text.trim().length === 0) return null;
      return (
        <details className="group/reasoning">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs text-gray-11 hover:text-gray-12 [&::-webkit-details-marker]:hidden">
            <SparkleIcon className="size-3" aria-hidden />
            Reasoning
          </summary>
          <p className="mt-2 whitespace-pre-wrap border-s-2 border-gray-a4 ps-3 text-xs text-gray-11">
            {part.text}
          </p>
        </details>
      );

    case "file":
      return (
        <Attachment size="sm" className="w-fit max-w-full">
          <AttachmentMedia>
            <FileIcon />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{part.filename ?? "Attachment"}</AttachmentTitle>
            <AttachmentDescription>{part.mediaType}</AttachmentDescription>
          </AttachmentContent>
          {part.url && (
            <AttachmentTrigger
              render={
                <a
                  href={part.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${part.filename ?? "attachment"}`}
                />
              }
            />
          )}
        </Attachment>
      );

    case "dynamic-tool": {
      const request = part.toolMetadata?.eve?.inputRequest;
      const label = part.toolName.replaceAll("_", " ");
      const running = part.state === "input-streaming" || part.state === "input-available";
      const expandable = part.input !== undefined || part.state === "output-available";

      const marker = (
        <Marker role={running ? "status" : undefined}>
          <MarkerIcon>
            {running ? (
              <Loader size={14} />
            ) : part.state === "output-error" || part.state === "output-denied" ? (
              <XIcon />
            ) : part.state === "output-available" ? (
              <CheckIcon />
            ) : (
              <WrenchIcon />
            )}
          </MarkerIcon>
          <MarkerContent className={running ? "shimmer" : undefined}>{label}</MarkerContent>
        </Marker>
      );

      return (
        <div className="flex flex-col gap-2">
          {expandable ? (
            <details>
              <summary className="w-fit cursor-pointer list-none rounded-md hover:brightness-125 [&::-webkit-details-marker]:hidden">
                {marker}
              </summary>
              <div className="mt-2 flex flex-col gap-2 border-s-2 border-gray-a4 ps-3">
                <ToolPayload label="Input" value={part.input} />
                {part.state === "output-available" && (
                  <ToolPayload label="Output" value={part.output} />
                )}
              </div>
            </details>
          ) : (
            marker
          )}
          {part.state === "output-error" && (
            <Bubble variant="destructive">
              <BubbleContent>{part.errorText}</BubbleContent>
            </Bubble>
          )}
          {part.state === "approval-requested" && request && (
            <Bubble variant="outline">
              <BubbleContent>
                <div className="flex flex-col gap-3">
                  <p>{request.prompt}</p>
                  <div className="flex flex-wrap gap-2">
                    {(request.options ?? []).map((option) => (
                      <Button
                        key={option.id}
                        size="sm"
                        variant={
                          option.style === "danger"
                            ? "destructive"
                            : option.style === "primary"
                              ? "primary"
                              : "secondary"
                        }
                        onClick={() => onRespond(request.requestId, option.id)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </BubbleContent>
            </Bubble>
          )}
        </div>
      );
    }

    case "authorization":
      if (part.state === "completed") {
        return (
          <Marker>
            <MarkerIcon>
              {part.outcome === "authorized" ? <CheckIcon /> : <XIcon />}
            </MarkerIcon>
            <MarkerContent>
              {part.outcome === "authorized"
                ? `${part.displayName} connected`
                : `${part.displayName} authorization ${part.outcome}`}
            </MarkerContent>
          </Marker>
        );
      }
      return (
        <Bubble variant="outline">
          <BubbleContent>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <KeyIcon className="size-4 text-gray-11" aria-hidden />
                {part.displayName}
              </div>
              <p className="text-sm text-gray-11">{part.description}</p>
              {part.authorization?.userCode && (
                <code className="w-fit rounded-md bg-gray-a3 px-2.5 py-1 font-mono text-sm tracking-widest">
                  {part.authorization.userCode}
                </code>
              )}
              {part.authorization?.url && (
                <LinkButton
                  href={part.authorization.url}
                  target="_blank"
                  variant="primary"
                  size="sm"
                  external
                  className="w-fit"
                >
                  Sign in
                </LinkButton>
              )}
            </div>
          </BubbleContent>
        </Bubble>
      );

    case "step-start":
      return null;

    default:
      return null;
  }
}
