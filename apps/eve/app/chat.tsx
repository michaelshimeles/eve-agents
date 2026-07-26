"use client";

import type { UserContent } from "ai";
import type { ClientSession, HandleMessageStreamEvent, SessionState } from "eve/client";
import { Client, defaultMessageReducer, isCurrentTurnBoundaryEvent } from "eve/client";
import { useEveAgent } from "eve/react";
import type { EveMessage, EveMessagePart } from "eve/react";
import { Button, Dialog, Input, InputArea, LinkButton, Loader } from "@cloudflare/kumo";
import {
  AlarmIcon,
  ArrowClockwiseIcon,
  ArrowUpIcon,
  BellIcon,
  BellSlashIcon,
  BrainIcon,
  CaretDownIcon,
  CheckIcon,
  CopyIcon,
  EnvelopeIcon,
  FileIcon,
  GearSixIcon,
  GitBranchIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  KeyIcon,
  MicrophoneIcon,
  MonitorIcon,
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
import { ComputerViewer } from "@/components/computer-viewer";
import { EmailClient } from "@/components/email-client";
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
import { AGENT_NAME, OWNER_NAME } from "@/lib/identity";
import {
  chatKey,
  clearTombstone,
  compactChatForStorage,
  fetchServerChat,
  fetchServerThreads,
  isStrippedUrl,
  loadDraft,
  loadSavedChat,
  loadTombstones,
  queueThreadDelete,
  queueThreadUpsert,
  recordTombstone,
  saveDraft,
  saveLocalChat,
  TOMBSTONES_KEY,
  type SavedChat,
  type ThreadMeta,
} from "@/lib/thread-sync";
import { cn } from "@/lib/utils";

const THREADS_KEY = "eve-web-threads";
const SEEN_KEY = "eve-web-threads-seen";
// Which thread is open rides in sessionStorage so it is per-tab: the shared
// index's activeId (kept as a cold-start fallback) is last-writer-wins across
// tabs, which used to reopen whatever thread *another* tab had active after a
// reload.
const ACTIVE_THREAD_KEY = "eve-web-active-thread";
const LEGACY_CHAT_KEY = "eve-web-chat";
const MODEL_KEY = "eve-web-model";
/** Last-resort default when `/api/models` is unreachable. Live default comes from the Gateway catalog. */
const FALLBACK_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5";
const REASONING_KEY = "eve-web-reasoning";
/** Models released within this window get a "New" mark in the picker. */
const NEW_MODEL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The desktop panel's visibility rides in the URL (`?desktop=1`) so a reload
 * or a shared link comes back with the panel open, and back/forward walk
 * through opening and closing it like any other navigation.
 */
const DESKTOP_PARAM = "desktop";

function desktopOpenFromLocation(): boolean {
  return new URLSearchParams(window.location.search).has(DESKTOP_PARAM);
}

/**
 * Reasoning effort riding along with each turn. "default" sends nothing and
 * leaves the provider's own default; the rest map to the AI SDK's
 * provider-agnostic effort levels (availability varies by model).
 */
const REASONING_OPTIONS = [
  { id: "default", name: "Default", description: "The model's own default" },
  { id: "none", name: "None", description: "No thinking; fastest replies" },
  { id: "minimal", name: "Minimal", description: "Barely any thinking" },
  { id: "low", name: "Low", description: "Quick thinking" },
  { id: "medium", name: "Medium", description: "Balanced thinking" },
  { id: "high", name: "High", description: "Thorough thinking; slower" },
  { id: "xhigh", name: "X-High", description: "Maximum thinking where supported" },
] as const;

type ReasoningId = (typeof REASONING_OPTIONS)[number]["id"];

function loadSavedReasoning(): ReasoningId {
  try {
    const saved = localStorage.getItem(REASONING_KEY);
    return REASONING_OPTIONS.some((option) => option.id === saved) ? (saved as ReasoningId) : "default";
  } catch {
    return "default";
  }
}

interface ModelOption {
  id: string;
  name: string;
  description?: string | null;
  pricing?: { input: string; output: string } | null;
  /** Unix seconds from the Gateway catalog; used for the "New" mark. */
  released?: number | null;
}

interface ModelsResponse {
  models?: ModelOption[];
  defaultModel?: string;
}

function isNewModel(released: number | null | undefined, now = Date.now()): boolean {
  if (released == null || !Number.isFinite(released)) return false;
  const releasedMs = released * 1000;
  return releasedMs <= now && now - releasedMs <= NEW_MODEL_WINDOW_MS;
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
    return localStorage.getItem(MODEL_KEY) ?? FALLBACK_DEFAULT_MODEL_ID;
  } catch {
    return FALLBACK_DEFAULT_MODEL_ID;
  }
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
        // This tab's own last-open thread wins over the shared activeId.
        let tabActiveId: string | null = null;
        try {
          tabActiveId = sessionStorage.getItem(ACTIVE_THREAD_KEY);
        } catch {
          // Session storage unavailable; use the shared value.
        }
        const activeId =
          tabActiveId !== null && parsed.threads.some((thread) => thread.id === tabActiveId)
            ? tabActiveId
            : parsed.threads.some((thread) => thread.id === parsed.activeId)
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

/**
 * Session cursor derived from the saved event log rather than trusted from
 * the saved cursor object. Mid-turn saves (and rows written by older code)
 * can carry a cursor that lags the events - a stream index from before the
 * turn, or a continuation token from an earlier park. Sending or streaming
 * with such a mixed cursor makes the client replay an old turn and stop at
 * its boundary, so a fresh exchange never renders. The saved events are
 * exactly the server stream, so the true index is their count, and the
 * right continuation token is the one carried by the last settled park.
 */
function normalizedSavedSession(chat: SavedChat): SessionState | undefined {
  const session = chat.session;
  if (session?.sessionId === undefined) return session;
  const events = chat.events ?? [];
  let continuationToken = session.continuationToken;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (isCurrentTurnBoundaryEvent(event)) {
      if (event.type === "session.waiting") continuationToken = event.data.continuationToken;
      break;
    }
  }
  if (session.streamIndex === events.length && session.continuationToken === continuationToken) {
    return session;
  }
  return { ...session, streamIndex: events.length, continuationToken };
}

/**
 * True when a saved chat was interrupted mid-turn: it has a server session
 * but its event log never reached the turn's settled boundary. The server
 * keeps running such turns (eve sessions are durable); the UI reattaches to
 * the session stream and catches up. Chats parked on a human-input prompt
 * are settled for our purposes - the normal composer path answers those.
 */
function isInterruptedChat(chat: SavedChat): boolean {
  if (chat.session?.sessionId === undefined) return false;
  const last = (chat.events ?? []).at(-1);
  // A session cursor with no persisted events yet means the first turn is
  // still in flight; replaying the stream from index 0 recovers it.
  if (last === undefined) return true;
  if (last.type === "input.requested" || last.type === "authorization.required") return false;
  return !isCurrentTurnBoundaryEvent(last);
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
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
  // Prompt-cache health: the share of input tokens served from the provider's
  // prompt cache. Shown only when the provider reported cache activity at all,
  // so models without cache reporting don't render a misleading 0%. A thread
  // stuck at 0% means every turn re-ingests the whole prompt (slow and ~10x
  // input price) - that's a regression worth investigating.
  if (usage.inputTokens > 0 && usage.cacheReadTokens + usage.cacheWriteTokens > 0) {
    pieces.push(`${Math.round((100 * usage.cacheReadTokens) / usage.inputTokens)}% cached`);
  }
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
      className="text-kumo-subtle"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}

/** An inline screenshot in a tool's output, when the tool captured one. */
function outputImageDataUrl(output: unknown): string | null {
  if (output === null || typeof output !== "object") return null;
  const { imageDataUrl } = output as { imageDataUrl?: unknown };
  return typeof imageDataUrl === "string" && imageDataUrl.startsWith("data:image/")
    ? imageDataUrl
    : null;
}

/**
 * The raw payload dump with any inline image collapsed to a stub: the image
 * renders right above it, and a megabyte of base64 would bury every other
 * field in the expanded view.
 */
function compactToolOutput(output: unknown): unknown {
  if (outputImageDataUrl(output) === null) return output;
  const { imageDataUrl, ...rest } = output as { imageDataUrl: string } & Record<string, unknown>;
  return { ...rest, imageDataUrl: `<inline image, ${Math.round(imageDataUrl.length / 1024)} kB>` };
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
      <span className="text-[10px] font-medium tracking-wide text-kumo-subtle uppercase">
        {label}
      </span>
      <pre className="max-h-64 overflow-auto rounded-md bg-kumo-recessed p-2 font-mono text-xs break-words whitespace-pre-wrap text-kumo-subtle">
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
    return <main className="h-dvh bg-kumo-canvas" />;
  }
  return <ChatApp initialView={initialView} />;
}

/** What the main column shows; the sidebar is shared across all of them. */
type MainView = "chat" | "manage" | "email";

const VIEW_PATHS: Record<MainView, string> = { chat: "/", manage: "/manage", email: "/email" };

function pathForView(view: MainView): string {
  return VIEW_PATHS[view];
}

function viewForPath(pathname: string): MainView {
  if (pathname === VIEW_PATHS.manage) return "manage";
  if (pathname === VIEW_PATHS.email) return "email";
  return "chat";
}

function ChatApp({ initialView }: { initialView: MainView }) {
  const [index, setIndex] = useState<ThreadIndex>(loadThreadIndex);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Live view of the cloud desktop, alongside whatever else is on screen.
  // Mirrored in the URL; change it through showDesktop, not the setter.
  const [desktopOpen, setDesktopOpen] = useState(desktopOpenFromLocation);
  const [hasDesktop, setHasDesktop] = useState(false);
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
  // Whether the main column shows the chat, the manage panel, or the email
  // client. The sidebar stays mounted either way; the URL is kept in sync via
  // pushState so /manage and /email are linkable and back/forward work without
  // remounting the app.
  const [view, setView] = useState<MainView>(initialView);
  // Web push opt-in for proactive notifications.
  const push = usePushNotifications();
  // Slash-command palette: built-ins plus skills saved from chat.
  const [commands, setCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS);
  // Model picker: live Gateway catalog (refreshed on mount and when opened).
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>(loadSavedModel);
  // Which optional surfaces this deployment shipped, so the nav hides pages
  // that would have nothing behind them. Assume present until told otherwise.
  const [features, setFeatures] = useState<{ email: boolean }>({ email: true });

  function applyModelsCatalog(body: ModelsResponse | null) {
    if (!body) return;
    const nextDefault =
      typeof body.defaultModel === "string" && body.defaultModel.length > 0
        ? body.defaultModel
        : FALLBACK_DEFAULT_MODEL_ID;
    if (!body.models?.length) return;
    setModels(body.models);
    // A saved model that left the catalog would fail every turn; fall
    // back to the live default rather than keep sending a stale id.
    setModel((current) => {
      if (body.models?.some((option) => option.id === current)) return current;
      try {
        localStorage.setItem(MODEL_KEY, nextDefault);
      } catch {
        // Storage unavailable; the reset still applies for this session.
      }
      return nextDefault;
    });
  }

  function refreshModels() {
    return fetch("/api/models")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: ModelsResponse | null) => {
        applyModelsCatalog(body);
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    void refreshModels();
  }, []);

  function selectModel(id: string) {
    setModel(id);
    try {
      localStorage.setItem(MODEL_KEY, id);
    } catch {
      // Storage unavailable; the selection still applies for this session.
    }
  }

  // Reasoning effort picker, persisted like the model selection.
  const [reasoning, setReasoning] = useState<ReasoningId>(loadSavedReasoning);

  function selectReasoning(id: ReasoningId) {
    setReasoning(id);
    try {
      localStorage.setItem(REASONING_KEY, id);
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

  // Remember this tab's open thread across its own reloads.
  useEffect(() => {
    try {
      sessionStorage.setItem(ACTIVE_THREAD_KEY, index.activeId);
    } catch {
      // Session storage unavailable; the shared activeId still applies.
    }
  }, [index.activeId]);

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

  // Only offer surfaces this deployment actually has - the desktop needs a
  // configured Orgo key, and the email page can be shipped or not. Saving or
  // removing a key in the manage panel announces itself so buttons appear or
  // vanish without a reload.
  useEffect(() => {
    function check(): void {
      void fetch("/api/features")
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { computer?: boolean; email?: boolean } | null) => {
          setHasDesktop(body?.computer === true);
          setFeatures({ email: body?.email !== false });
        })
        .catch(() => undefined);
    }
    check();
    window.addEventListener("eve:features-changed", check);
    return () => window.removeEventListener("eve:features-changed", check);
  }, []);

  // Callbacks and the sync sweep need the live busy set, not a stale capture.
  const busyIdsRef = useRef(busyIds);
  useEffect(() => {
    busyIdsRef.current = busyIds;
  }, [busyIds]);

  // Pull the server's thread list on load: prefer the newer copy of each
  // thread, adopt threads created on other devices, and re-push any thread
  // whose local copy is ahead of the server (a PUT that failed or never got
  // to run before the tab died). Re-synced on focus/visibility and on a slow
  // interval so proactive threads (fired reminders) show up while the app
  // stays open.
  useEffect(() => {
    function syncServerThreads() {
      void fetchServerThreads().then((serverThreads) => {
        if (!serverThreads) return;
        // Threads deleted here must not come back just because the server
        // still has them (a DELETE that hasn't landed yet); re-issue the
        // delete instead. A thread written elsewhere *after* our delete is
        // treated as recreated and adopted.
        const tombstones = loadTombstones();
        const liveServerThreads: ThreadMeta[] = [];
        for (const thread of serverThreads) {
          const deletedAt = tombstones[thread.id];
          if (deletedAt !== undefined) {
            if (thread.updatedAt > deletedAt) clearTombstone(thread.id);
            else {
              queueThreadDelete(thread.id);
              continue;
            }
          }
          liveServerThreads.push(thread);
        }
        const serverById = new Map(liveServerThreads.map((thread) => [thread.id, thread]));
        // Reconciliation: the server should never stay behind a local copy.
        // Index updatedAt mirrors the local chat's write stamp, so a cheap
        // meta comparison decides whether the (potentially large) local copy
        // even needs to be parsed. Busy threads are skipped - their stream
        // persistence is already writing through the queue.
        for (const thread of indexRef.current.threads) {
          if (busyIdsRef.current.has(thread.id)) continue;
          const server = serverById.get(thread.id);
          if (server !== undefined && server.updatedAt >= thread.updatedAt) continue;
          const chat = loadSavedChat(thread.id);
          if (!chat?.events?.length) continue;
          const stamp = Math.max(thread.updatedAt, chat.savedAt ?? 0);
          if (server !== undefined && server.updatedAt >= stamp) continue;
          queueThreadUpsert({ ...thread, updatedAt: stamp }, chat);
        }
        setIndex((prev) => {
          const byId = new Map<string, ThreadMeta>(
            liveServerThreads.map((thread) => [thread.id, thread]),
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
            for (const thread of liveServerThreads) seeded[thread.id] = thread.updatedAt;
            for (const thread of indexRef.current.threads) {
              seeded[thread.id] = Math.max(seeded[thread.id] ?? 0, thread.updatedAt);
            }
            return { ...seeded, ...prev };
          });
        }
      });
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") syncServerThreads();
    }
    syncServerThreads();
    const timer = setInterval(syncServerThreads, 60_000);
    window.addEventListener("focus", syncServerThreads);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", syncServerThreads);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Cross-tab sync: storage events only fire for writes from *other* tabs,
  // so they are exactly the signal that another tab changed the thread list
  // or deleted a thread. (Fresher chat bodies are adopted by the mounted
  // thread itself, which knows how far its own copy goes.)
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.newValue === null) return;
      if (event.key === THREADS_KEY) {
        let parsed: ThreadIndex;
        try {
          parsed = JSON.parse(event.newValue) as ThreadIndex;
        } catch {
          return;
        }
        if (!Array.isArray(parsed.threads)) return;
        setIndex((prev) => {
          let changed = false;
          const byId = new Map(prev.threads.map((thread) => [thread.id, thread]));
          for (const thread of parsed.threads) {
            const existing = byId.get(thread.id);
            if (existing === undefined || thread.updatedAt > existing.updatedAt) {
              byId.set(thread.id, thread);
              changed = true;
            } else if (
              thread.updatedAt === existing.updatedAt &&
              (thread.title !== existing.title ||
                thread.pinned !== existing.pinned ||
                thread.renamed !== existing.renamed)
            ) {
              // Renames and pins deliberately keep updatedAt; adopt them too.
              byId.set(thread.id, thread);
              changed = true;
            }
          }
          return changed ? { activeId: prev.activeId, threads: [...byId.values()] } : prev;
        });
      } else if (event.key === TOMBSTONES_KEY) {
        // Another tab deleted threads; drop them here too.
        const tombstones = loadTombstones();
        setIndex((prev) => {
          const threads = prev.threads.filter((thread) => {
            const deletedAt = tombstones[thread.id];
            return deletedAt === undefined || thread.updatedAt > deletedAt;
          });
          if (threads.length === prev.threads.length) return prev;
          if (threads.length === 0) {
            const meta = newThreadMeta();
            return { activeId: meta.id, threads: [meta] };
          }
          const activeId = threads.some((thread) => thread.id === prev.activeId)
            ? prev.activeId
            : [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
          return { activeId, threads };
        });
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Resolve the active thread's chat: localStorage first, then the server
  // One stream reattach per thread visit: onResumed records the attempt so a
  // dead stream can't loop settle -> remount -> reattach. Navigating away and
  // back grants a fresh attempt.
  const resumeAttemptRef = useRef(new Map<string, number>());

  // (for threads that live on another device or after cleared storage).
  // Local hits resolve during render so switching threads never paints the
  // intermediate spinner frame.
  if (activeChat?.threadId !== index.activeId) {
    resumeAttemptRef.current.clear();
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
      // Event logs only grow, so "not strictly more events than the local
      // copy" means the server has nothing we don't (often our own PUT is
      // simply still in flight). Never replace existing local content with a
      // shorter copy - and never with an empty one when the fetch failed.
      if (local !== null && (chat?.events?.length ?? 0) <= (local.events?.length ?? 0)) {
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

  /**
   * The one write path for chat content. Event logs only grow, so a persist
   * carrying fewer events than the stored copy is by definition stale (e.g.
   * a flush from a mount that another tab has advanced past) and is dropped
   * whole - the server applies the same rule. Accepted writes are stamped
   * with a per-thread monotonic timestamp used consistently in three places
   * (the local copy's savedAt, the thread meta's updatedAt, the server row)
   * so recency comparisons hold across tabs and devices regardless of clock
   * skew. The persisted copy is compacted (huge inline data URLs stripped)
   * so neither the localStorage quota nor the server's body limit can
   * reject it, and the server write rides the retrying per-thread queue.
   */
  function persistChat(threadId: string, chat: SavedChat) {
    const existing = loadSavedChat(threadId);
    if (existing !== null && (existing.events?.length ?? 0) > (chat.events?.length ?? 0)) {
      return;
    }
    const meta = indexRef.current.threads.find((thread) => thread.id === threadId);
    const savedAt = Math.max(Date.now(), (meta?.updatedAt ?? 0) + 1);
    const compacted = compactChatForStorage({ ...chat, savedAt });
    saveLocalChat(threadId, compacted);
    if (!meta) return;
    setIndex((prev) => ({
      ...prev,
      threads: prev.threads.map((thread) =>
        thread.id === threadId ? { ...thread, updatedAt: savedAt } : thread,
      ),
    }));
    queueThreadUpsert({ ...meta, updatedAt: savedAt }, compacted);
  }

  /**
   * Another tab wrote a fresher copy of the active thread (reported by its
   * mounted ChatThread, which knows how far its own event log goes): remount
   * with the fuller copy. No re-persist here - the copy came *from* storage.
   */
  function adoptExternalChat(threadId: string, chat: SavedChat) {
    setActiveChat((prev) =>
      prev?.threadId === threadId
        ? { threadId, chat, revision: (prev.revision ?? 0) + 1 }
        : prev,
    );
  }

  /**
   * A reattached stream settled (turn boundary, park, or dead stream):
   * persist what it collected and remount the thread so useEveAgent
   * re-initializes from the complete event log and fresh session cursor.
   */
  function adoptResumedChat(threadId: string, chat: SavedChat) {
    resumeAttemptRef.current.set(threadId, chat.events?.length ?? 0);
    persistChat(threadId, chat);
    setActiveChat((prev) =>
      prev?.threadId === threadId
        ? { threadId, chat, revision: (prev.revision ?? 0) + 1 }
        : prev,
    );
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

  // Back/forward between "/", "/manage", and "/email", plus the desktop
  // panel's open state (we navigate with pushState so the app, and especially
  // the sidebar, never remounts).
  useEffect(() => {
    function onPopState() {
      setView(viewForPath(window.location.pathname));
      setDesktopOpen(desktopOpenFromLocation());
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const sections = sectionThreads(index.threads, searchQuery, contentMatchIds);

  function showView(next: MainView) {
    setView(next);
    const path = pathForView(next);
    if (window.location.pathname !== path) {
      // Keep the query string: the desktop panel stays open across the switch.
      window.history.pushState(null, "", path + window.location.search);
    }
  }

  /** Open or close the desktop panel, recording it in the URL. */
  function showDesktop(open: boolean) {
    setDesktopOpen(open);
    const url = new URL(window.location.href);
    if (url.searchParams.has(DESKTOP_PARAM) === open) return;
    if (open) url.searchParams.set(DESKTOP_PARAM, "1");
    else url.searchParams.delete(DESKTOP_PARAM);
    window.history.pushState(null, "", url.pathname + url.search);
  }

  function newThread() {
    const meta = newThreadMeta();
    // Seed the local chat (stamped current) so the new thread renders
    // without a server probe.
    saveLocalChat(meta.id, { savedAt: meta.updatedAt });
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
    const base = newThreadMeta();
    const meta: ThreadMeta = {
      ...base,
      title: source ? `Fork: ${source.title}`.slice(0, 80) : "Forked thread",
      // Protect the fork title from the auto-titling backfill.
      renamed: true,
    };
    const saved = compactChatForStorage({ ...chat, savedAt: meta.updatedAt });
    saveLocalChat(meta.id, saved);
    queueThreadUpsert(meta, saved);
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
    saveDraft(id, "");
    // The tombstone keeps the periodic sync (and other tabs) from
    // resurrecting the thread while the server DELETE retries.
    recordTombstone(id);
    queueThreadDelete(id);
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
              // Monotonic, like persistChat's stamps, so activity can never
              // move a thread's clock backwards.
              updatedAt: Math.max(Date.now(), thread.updatedAt + 1),
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
    queueThreadUpsert(meta);
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
    queueThreadUpsert(meta);
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
    <div
      className={cn(
        "flex h-dvh w-full",
        // Give the desktop panel its own space instead of covering what is on
        // screen, once the window is wide enough to spare it.
        desktopOpen && "lg:pe-[36rem]",
      )}
    >
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          aria-hidden
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-40 flex w-64 shrink-0 -translate-x-full flex-col border-e border-kumo-hairline bg-kumo-elevated transition-transform duration-200 md:static md:translate-x-0",
          sidebarOpen && "translate-x-0",
        )}
      >
        <div className="flex items-center justify-between px-3 py-2.5">
          <button
            type="button"
            className="rounded-sm text-sm font-semibold hover:text-kumo-strong"
            aria-label="Back to chat"
            title="Back to chat"
            onClick={() => showView("chat")}
          >
            {AGENT_NAME}
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
                className={cn(push.status !== "on" && "text-kumo-subtle")}
                onClick={push.toggle}
              />
            )}
            {features.email && (
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={EnvelopeIcon}
                aria-label="Email"
                aria-pressed={view === "email"}
                title={`Email: ${AGENT_NAME}'s own inbox`}
                className={cn(view === "email" && "bg-kumo-tint text-kumo-strong")}
                onClick={() => showView(view === "email" ? "chat" : "email")}
              />
            )}
            {hasDesktop && (
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={MonitorIcon}
                aria-label={`${AGENT_NAME}'s desktop`}
                aria-pressed={desktopOpen}
                title={`${AGENT_NAME}'s desktop: watch her cloud computer live`}
                className={cn(
                  desktopOpen ? "bg-kumo-tint text-kumo-strong" : "text-kumo-subtle",
                )}
                onClick={() => showDesktop(!desktopOpen)}
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
              className={cn(view === "manage" && "bg-kumo-tint text-kumo-strong")}
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
            <Input
              size="sm"
              value={searchQuery}
              placeholder="Search threads"
              aria-label="Search threads"
              className="w-full pe-7 ring-kumo-hairline"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            {searchQuery.length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute end-1.5 top-1/2 -translate-y-1/2 text-kumo-subtle hover:text-kumo-default"
                onClick={() => setSearchQuery("")}
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {sections.every((section) => section.threads.length === 0) && (
            <p className="px-2.5 py-2 text-xs text-kumo-subtle">No threads match.</p>
          )}
          {sections.map((section) => (
            <div key={section.label ?? "results"} className="pb-2">
              {section.label && (
                <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-kumo-subtle">
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
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={SidebarSimpleIcon}
            className="absolute start-2 top-2 z-20 md:hidden"
            aria-label="Open threads"
            onClick={() => setSidebarOpen(true)}
          />
          <div className="w-full max-w-3xl px-6 py-6">
            <header className="mb-5">
              <h1 className="text-lg font-semibold">Manage</h1>
              <p className="text-sm text-kumo-subtle">
                What {AGENT_NAME} does and knows on her own. Create reminders, triggers, and
                skills by asking in chat.
              </p>
            </header>
            <ManagePanel onOpenThread={selectThread} />
          </div>
        </main>
      ) : view === "email" ? (
        <EmailClient onOpenSidebar={() => setSidebarOpen(true)} />
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
          onRefreshModels={refreshModels}
          reasoning={reasoning}
          onReasoningChange={selectReasoning}
          allowResume={
            resumeAttemptRef.current.get(index.activeId) !==
            (activeChat.chat.events?.length ?? 0)
          }
          onResumed={(chat) => adoptResumedChat(index.activeId, chat)}
          onExternalUpdate={(chat) => adoptExternalChat(index.activeId, chat)}
          onWatchDesktop={() => showDesktop(true)}
          hasDesktop={hasDesktop}
        />
      ) : (
        <main className="flex h-dvh min-w-0 flex-1 items-center justify-center text-kumo-subtle">
          <Loader size={20} />
        </main>
      )}

      {desktopOpen && <DesktopDrawer onClose={() => showDesktop(false)} />}

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        threads={[...index.threads]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((thread) => ({ id: thread.id, title: thread.title, updatedAt: thread.updatedAt }))}
        onSelectThread={selectThread}
        onNewChat={newThread}
        onOpenManage={() => showView("manage")}
        onOpenEmail={features.email ? () => showView("email") : undefined}
        pushStatus={push.status}
        onTogglePush={push.toggle}
      />

      <Dialog.Root open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <Dialog size="base" className="p-6">
          <Dialog.Title>Delete thread?</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-kumo-subtle">
            &ldquo;{threadToDelete?.title}&rdquo; and its local history will be removed. This
            can&rsquo;t be undone.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" size="sm" {...props}>
                  Cancel
                </Button>
              )}
            />
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
        </Dialog>
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
          className="w-full rounded-md bg-kumo-base px-2.5 py-2 text-sm text-kumo-default ring ring-kumo-focus outline-none"
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
          "w-full rounded-md py-1.5 pe-8 ps-4 text-start group-hover/thread:bg-kumo-tint",
          active && "bg-kumo-tint text-kumo-strong",
        )}
      >
        <span className="relative flex items-center">
          {(busy || unread) && (
            <span
              className={cn(
                "absolute -start-1 size-1.5 shrink-0 -translate-x-full rounded-full bg-kumo-brand rtl:translate-x-full",
                busy && "animate-pulse",
              )}
              role="status"
              aria-label={busy ? "Turn in progress" : "Unread activity"}
            />
          )}
          <span className={cn("truncate text-sm", unread && "font-medium text-kumo-strong")}>
            {thread.title}
          </span>
          {thread.origin === "reminder" && (
            <AlarmIcon
              className="ms-1.5 size-3 shrink-0 text-kumo-subtle"
              aria-label="Started by a reminder"
            />
          )}
          {thread.origin === "webhook" && (
            <LightningIcon
              className="ms-1.5 size-3 shrink-0 text-kumo-subtle"
              aria-label="Started by a webhook"
            />
          )}
          {thread.origin === "email" && (
            <EnvelopeIcon
              className="ms-1.5 size-3 shrink-0 text-kumo-subtle"
              aria-label="Started by an incoming email"
            />
          )}
        </span>
        <span className="block text-xs text-kumo-subtle">
          {formatThreadDate(thread.updatedAt)}
        </span>
      </button>
      <div className="absolute end-1 top-1/2 flex -translate-y-1/2 items-center rounded-md bg-kumo-tint opacity-0 focus-within:opacity-100 group-hover/thread:opacity-100">
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
  threadId,
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
  onRefreshModels,
  reasoning,
  onReasoningChange,
  allowResume,
  onResumed,
  onExternalUpdate,
  onWatchDesktop,
  hasDesktop,
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
  /** Re-fetch the Gateway catalog when the picker opens. */
  onRefreshModels: () => void;
  reasoning: ReasoningId;
  onReasoningChange: (id: ReasoningId) => void;
  /** Gate on the interrupted-turn stream reattach (one attempt per visit). */
  allowResume: boolean;
  /** A reattached stream settled; remount me with the merged chat. */
  onResumed: (chat: SavedChat) => void;
  /** Another tab wrote a fresher copy of this thread; remount me with it. */
  onExternalUpdate: (chat: SavedChat) => void;
  /** Opens the live view of the cloud desktop, shared with the app header. */
  onWatchDesktop: () => void;
  /** Whether this deployment has a cloud desktop; gates the composer toggle. */
  hasDesktop: boolean;
}) {
  // Drafts survive reloads and remounts (fork prefills take precedence).
  const [draft, setDraft] = useState(() => initialDraft ?? loadDraft(threadId));
  useEffect(() => {
    saveDraft(threadId, draft);
  }, [threadId, draft]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Composer toggle: steer this thread's work onto the cloud desktop. Off
  // means "agent's choice", not "don't use the computer" - the flag only
  // rides along while it is on.
  const [useComputer, setUseComputer] = useState(false);
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

  // Interrupted-turn recovery: when the saved chat ends mid-turn (the user
  // switched threads or reloaded while the agent was replying), reattach to
  // the durable session's stream and catch up live. null means no reattach;
  // an array collects the replayed/live events until the turn settles.
  const [resumedEvents, setResumedEvents] = useState<readonly HandleMessageStreamEvent[] | null>(
    () => (allowResume && isInterruptedChat(initialChat) ? [] : null),
  );
  const resuming = resumedEvents !== null;

  // Mirror of the authoritative stream, kept by the store callbacks rather
  // than render effects so persistence keeps working after this component
  // unmounts (the store finishes the turn in the background).
  const liveRef = useRef<{
    events: HandleMessageStreamEvent[];
    session: SessionState | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
  }>({ events: [...(initialChat.events ?? [])], session: initialChat.session, timer: undefined });

  // The session handle is created here (not owned by the store) so its state
  // is readable from stream callbacks: the session id appears on it the
  // moment a send is accepted, long before the turn ends. Without it, saves
  // from a turn running after unmount carried no session id, leaving an
  // interrupted chat unresumable - the reply was lost for good. The cursor
  // is re-derived from the saved events so a mixed save can't make the next
  // send replay an old turn (see normalizedSavedSession).
  const sessionRef = useRef<ClientSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = new Client({ host: "" }).session(normalizedSavedSession(initialChat));
  }

  function persistLive() {
    const live = liveRef.current;
    const sessionState = sessionRef.current?.state;
    if (sessionState?.sessionId !== undefined) live.session = sessionState;
    clearTimeout(live.timer);
    live.timer = undefined;
    onPersist({ events: [...live.events], session: live.session });
  }

  const agent = useEveAgent({
    session: sessionRef.current,
    initialEvents: initialChat.events ?? [],
    // Ride the selected gateway model (and reasoning effort, when set) along
    // with every turn; the agent's dynamic model resolver reads them from the
    // turn's client context. clientTime gives the agent the exact minute
    // without a system-prompt clock (which would bust the prompt cache every
    // turn). Forked threads also carry their source transcript on the first
    // turn.
    prepareSend: (input) => {
      // Answering an approval or a question sends only inputResponses. The
      // channel delivers clientContext as a user-role message, so attaching it
      // to a send with no message of its own puts a text-free turn in front of
      // the agent, which it then remarks on ("your message came through
      // empty"). The marker from the previous turn is still in the transcript,
      // so the model selection survives being left off here.
      if (input.message === undefined) return input;

      const forkedThreadTranscript = forkContextRef.current;
      forkContextRef.current = undefined;
      return {
        ...input,
        clientContext: {
          eveWebModel: model,
          ...(reasoning !== "default" ? { eveWebReasoning: reasoning } : {}),
          // The composer's computer toggle: the desktop instructions tell the
          // agent this flag means "do this on your cloud desktop".
          ...(useComputer ? { eveWebUseComputer: true } : {}),
          clientTime: new Date().toLocaleString("en-CA", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }),
          ...(forkedThreadTranscript !== undefined ? { forkedThreadTranscript } : {}),
        },
      };
    },
    // Persist through the turn so an interruption (thread switch, reload)
    // never loses the conversation: immediately when the user message lands,
    // debounced between deltas, and settled in onFinish. The turn-boundary
    // event itself deliberately does not persist: the session cursor only
    // advances right after it, and a copy saved in that gap (settled events,
    // pre-turn cursor) reads as current to other tabs while pointing their
    // next send at an old turn. Runs even after unmount, so a backgrounded
    // turn keeps writing through to storage.
    onEvent(event) {
      const live = liveRef.current;
      live.events.push(event);
      if (event.type === "message.received") {
        persistLive();
      } else {
        clearTimeout(live.timer);
        live.timer = setTimeout(persistLive, 800);
      }
      // Clear the sidebar busy dot when a backgrounded turn settles; the
      // mounted case is handled by the isBusy effect below.
      if (isCurrentTurnBoundaryEvent(event)) onBusyChange(false);
    },
    // Fires at turn boundaries with the advanced cursor (continuation token,
    // stream index); keeps the mirror fresh for the final flush even when
    // this component is already unmounted.
    onSessionChange(session) {
      liveRef.current.session = session;
    },
    // Runs after onSessionChange, so this persist carries the settled events
    // together with the advanced cursor, and its updatedAt bump (stamped by
    // persistChat) makes completion visible to other tabs and devices.
    onFinish() {
      persistLive();
    },
  });

  // Flush a save the moment the session id first exists: from then on an
  // interrupted copy is resumable. (persistLive itself mirrors the id from
  // the session handle, so mid-turn saves carry it even after unmount; this
  // effect just makes sure a save happens promptly.)
  const persistedSessionId = useRef<string | undefined>(initialChat.session?.sessionId);
  useEffect(() => {
    const sessionId = agent.session.sessionId;
    if (sessionId === undefined || persistedSessionId.current === sessionId) return;
    persistedSessionId.current = sessionId;
    persistLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.session.sessionId]);

  // localStorage writes are synchronous, so flushing the debounced mid-turn
  // save when the page hides or unloads means a reload can only ever lose
  // events that hadn't arrived yet - never the tail of what already streamed.
  // (The server write queue has its own keepalive unload flush.)
  useEffect(() => {
    function flushPending() {
      if (liveRef.current.timer !== undefined) persistLive();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") flushPending();
    }
    window.addEventListener("pagehide", flushPending);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushPending);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reattach to an interrupted turn: replay the session stream from the
  // events we already have, render and persist as it advances, and settle at
  // the turn boundary (or a human-input park, which the normal composer path
  // handles after the remount that onResumed triggers).
  useEffect(() => {
    if (!resuming) return;
    const controller = new AbortController();
    const base = initialChat.events ?? [];
    const collected: HandleMessageStreamEvent[] = [];
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const client = new Client({ host: window.location.origin });
    const session = client.session(normalizedSavedSession(initialChat));
    (async () => {
      try {
        for await (const event of session.stream({
          startIndex: base.length,
          signal: controller.signal,
        })) {
          collected.push(event);
          setResumedEvents([...collected]);
          clearTimeout(persistTimer);
          persistTimer = setTimeout(() => {
            onPersist({ events: [...base, ...collected], session: session.state });
          }, 800);
          if (
            isCurrentTurnBoundaryEvent(event) ||
            event.type === "input.requested" ||
            event.type === "authorization.required"
          ) {
            break;
          }
        }
      } catch {
        // Stream unavailable (network, pruned session): settle with what we
        // have; the attempt guard keeps this from looping.
      }
      if (controller.signal.aborted) return;
      clearTimeout(persistTimer);
      settled = true;
      onBusyChange(false);
      onActivity();
      onResumed({ events: [...base, ...collected], session: session.state });
    })();
    return () => {
      controller.abort();
      clearTimeout(persistTimer);
      // Keep whatever the reattach collected: navigating away mid-catch-up
      // must not drop events that were already replayed to this tab. (A
      // settled resume already persisted through onResumed.)
      if (!settled && collected.length > 0) {
        onPersist({ events: [...base, ...collected], session: session.state });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While reattached, render the merged log through the same reducer the
  // agent store uses, so the view is indistinguishable from a live turn.
  const events = useMemo(
    () => (resumedEvents === null ? agent.events : [...(initialChat.events ?? []), ...resumedEvents]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent.events, resumedEvents],
  );
  const messages = useMemo(() => {
    if (resumedEvents === null) return agent.data.messages;
    const reducer = defaultMessageReducer();
    let projected = reducer.initial();
    for (const event of events) projected = reducer.reduce(projected, event);
    return projected.messages;
  }, [agent.data.messages, events, resumedEvents]);

  // Backfill titles for threads restored from storage (e.g. the migrated
  // pre-threads chat) whose meta still has the placeholder title.
  useEffect(() => {
    const title = deriveTitle(agent.data.messages);
    if (title) onTitle(title);
    // Intentionally run once per mounted thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isBusy = resuming || agent.status === "submitted" || agent.status === "streaming";

  // Report turn activity up so the sidebar can dot busy threads. Deliberately
  // not cleared on unmount: a turn keeps running server-side when the user
  // switches threads, and revisiting the thread resolves the real status.
  useEffect(() => {
    onBusyChange(isBusy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy]);

  // Live cross-tab updates: storage events fire only for writes from other
  // tabs, so a fresher copy under this thread's key means another tab (or a
  // turn backgrounded there) advanced the conversation. Adopt it unless this
  // tab is itself streaming - its own store is the authority then.
  useEffect(() => {
    if (isBusy) return;
    function onStorage(event: StorageEvent) {
      if (event.key !== chatKey(threadId) || event.newValue === null) return;
      let parsed: SavedChat;
      try {
        parsed = JSON.parse(event.newValue) as SavedChat;
      } catch {
        return;
      }
      if ((parsed.events?.length ?? 0) > liveRef.current.events.length) {
        onExternalUpdate(parsed);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy, threadId]);

  // Per-turn cost/token totals from step.completed events, keyed by turnId so
  // each assistant reply can show what it cost.
  const usageByTurn = useMemo(() => {
    const map = new Map<string, TurnUsage>();
    for (const event of events) {
      if (event.type !== "step.completed") continue;
      const usage = event.data.usage;
      if (!usage) continue;
      const entry = map.get(event.data.turnId) ?? {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      entry.costUsd += usage.costUsd ?? 0;
      entry.inputTokens += usage.inputTokens ?? 0;
      entry.outputTokens += usage.outputTokens ?? 0;
      entry.cacheReadTokens += usage.cacheReadTokens ?? 0;
      entry.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      map.set(event.data.turnId, entry);
    }
    return map;
  }, [events]);

  const threadUsage = useMemo(() => {
    const total: TurnUsage = {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    for (const usage of usageByTurn.values()) {
      total.costUsd += usage.costUsd;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cacheReadTokens += usage.cacheReadTokens;
      total.cacheWriteTokens += usage.cacheWriteTokens;
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
    onActivity(messages.length === 0 ? toThreadTitle(titleSource) : undefined);
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
    // During a reattached turn the agent store is idle; the session id from
    // the shared handle (or the saved cursor) targets the running turn.
    const sessionId =
      agent.session?.sessionId ??
      sessionRef.current?.state.sessionId ??
      initialChat.session?.sessionId;
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
    const lastUser = messages.findLast((message) => message.role === "user");
    if (!lastUser) return;
    retryMessage(messageText(lastUser));
  }

  /** Plain-text transcript of `messages` for the fork's client context. */
  function buildTranscript(messages: readonly EveMessage[]): string | undefined {
    const lines = messages
      .map((message) => {
        const text = messageText(message);
        return text.length > 0
          ? `${message.role === "user" ? OWNER_NAME : AGENT_NAME}: ${text}`
          : null;
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

    const messageIndex = messages.findIndex((entry) => entry.id === message.id);
    const carried =
      messageIndex >= 0
        ? messages.slice(0, includeTurn ? messageIndex + 1 : messageIndex)
        : messages;

    onFork({ events: sliced, forkContext: buildTranscript(carried) }, draftText);
  }

  const hasMessages = messages.length > 0;
  const lastUserId = messages.findLast((message) => message.role === "user")?.id;
  const lastAssistantId = messages.findLast(
    (message) => message.role === "assistant",
  )?.id;
  // Keep the thinking indicator up until the reply has something to show;
  // reasoning models can stream for a while before any visible output.
  const lastMessage = messages.at(-1);
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
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-kumo-canvas/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-xl border-2 border-dashed border-kumo-interact px-8 py-6 text-sm font-medium">
            <PaperclipIcon className="size-4" />
            Drop files to attach
          </div>
        </div>
      )}
      <div className="mx-auto flex size-full max-w-3xl min-h-0 flex-col px-4">
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={SidebarSimpleIcon}
          className="absolute start-2 top-2 z-20 md:hidden"
          aria-label="Open threads"
          onClick={onOpenSidebar}
        />

        <MessageScrollerProvider autoScroll>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport className="[scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
              <MessageScrollerContent className="gap-5 py-6">
                {!hasMessages && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                    <h2 className="text-lg font-semibold text-kumo-default">Hey {OWNER_NAME}</h2>
                    <p className="max-w-sm text-sm text-kumo-subtle">
                      Ask me anything — I have your memory, a browser, and all your connected apps.
                    </p>
                  </div>
                )}
                {messages.map((message, index) => (
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
                      onWatchDesktop={onWatchDesktop}
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
              className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded-lg bg-kumo-base shadow-lg ring ring-kumo-line"
            >
              <p className="px-3 pt-2 pb-1 text-[11px] font-medium text-kumo-subtle">
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
                      commandIndex === activePaletteIndex && "bg-kumo-tint text-kumo-strong",
                    )}
                    // Keep the textarea focused; the click still fires.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setPaletteIndex(commandIndex)}
                    onClick={() => applyCommand(command)}
                  >
                    <span className="shrink-0 font-mono text-xs font-medium">/{command.name}</span>
                    <span className="truncate text-xs text-kumo-subtle">
                      {command.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <form
            className="rounded-xl bg-kumo-base p-2 ring ring-kumo-hairline focus-within:ring-kumo-focus/40"
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
            <InputArea
              ref={composerRef}
              value={draft}
              aria-label={`Message ${AGENT_NAME}`}
              placeholder={`Message ${AGENT_NAME}... (/ for commands)`}
              autoResize
              minRows={1}
              maxRows={7}
              className="w-full rounded-none bg-transparent px-1 text-sm ring-0 focus:ring-0"
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
                className="text-kumo-subtle"
                onClick={() => fileInputRef.current?.click()}
              />
              <div className="ms-auto flex items-center gap-1">
                {hasDesktop && (
                  <Button
                    type="button"
                    variant="ghost"
                    shape="square"
                    icon={MonitorIcon}
                    aria-label="Do this on the computer"
                    aria-pressed={useComputer}
                    title={
                      useComputer
                        ? `${AGENT_NAME} will do this on her computer - click to leave the choice to her`
                        : `Have ${AGENT_NAME} do this on her computer`
                    }
                    className={cn(
                      useComputer ? "bg-kumo-tint !text-kumo-strong" : "text-kumo-subtle",
                    )}
                    onClick={() => setUseComputer((value) => !value)}
                  />
                )}
                <ReasoningPicker reasoning={reasoning} onSelect={onReasoningChange} />
                <ModelPicker
                  model={model}
                  models={models}
                  onSelect={onModelChange}
                  onOpen={onRefreshModels}
                />
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
                      "text-kumo-subtle",
                      listening && "animate-pulse !text-kumo-danger",
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
          <p className="h-6 pt-2 text-center text-[11px] text-kumo-subtle">
            {threadUsage.inputTokens > 0 ? `${formatUsage(threadUsage)} this thread` : "\u00A0"}
          </p>
        </footer>
      </div>
    </main>
  );
}

/**
 * Side panel holding the live desktop. Deliberately not a modal: the point is
 * to watch the agent work while the conversation carries on next to it.
 */
function DesktopDrawer({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" aria-hidden onClick={onClose} />
      <aside
        aria-label={`${AGENT_NAME}'s desktop`}
        className="fixed inset-y-0 end-0 z-50 flex w-full max-w-xl flex-col gap-3 border-s border-kumo-hairline bg-kumo-elevated p-4 shadow-xl"
      >
        <div className="flex items-center gap-2">
          <MonitorIcon className="size-4" />
          <h2 className="text-sm font-medium">{AGENT_NAME}&rsquo;s desktop</h2>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={XIcon}
            aria-label="Close desktop"
            className="ms-auto"
            onClick={onClose}
          />
        </div>
        <ComputerViewer />
      </aside>
    </>
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

function ReasoningPicker({
  reasoning,
  onSelect,
}: {
  reasoning: ReasoningId;
  onSelect: (id: ReasoningId) => void;
}) {
  const [open, setOpen] = useState(false);
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

  const selected = REASONING_OPTIONS.find((option) => option.id === reasoning);

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        aria-label="Select reasoning effort"
        aria-expanded={open}
        title="Reasoning effort"
        className="text-kumo-subtle hover:text-kumo-default"
        onClick={() => setOpen((prev) => !prev)}
      >
        <BrainIcon className="size-4 shrink-0" weight={reasoning === "default" ? "regular" : "fill"} />
        {reasoning !== "default" && <span className="truncate">{selected?.name}</span>}
        <CaretDownIcon className="size-3 shrink-0" />
      </Button>
      {open && (
        <div className="absolute bottom-full end-0 z-30 mb-2 flex w-60 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl bg-kumo-base shadow-lg ring ring-kumo-line">
          <div role="listbox" aria-label="Reasoning effort" className="p-1.5">
            {REASONING_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={option.id === reasoning}
                className="w-full rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-kumo-tint"
                onClick={() => {
                  onSelect(option.id);
                  setOpen(false);
                }}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{option.name}</span>
                  {option.id === reasoning && <CheckIcon className="size-3.5 shrink-0" />}
                </span>
                <span className="block truncate text-xs text-kumo-subtle">{option.description}</span>
              </button>
            ))}
          </div>
          <p className="border-t border-kumo-hairline px-3 py-2 text-[11px] text-kumo-subtle">
            Applies to the next message. Levels vary by model.
          </p>
        </div>
      )}
    </div>
  );
}

function ModelPicker({
  model,
  models,
  onSelect,
  onOpen,
}: {
  model: string;
  models: ModelOption[];
  onSelect: (id: string) => void;
  /** Pull a fresh Gateway catalog each time the menu opens. */
  onOpen?: () => void;
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
        className="max-w-40 text-kumo-subtle hover:text-kumo-default"
        onClick={() => {
          setOpen((prev) => {
            const next = !prev;
            if (next) onOpen?.();
            return next;
          });
          setQuery("");
        }}
      >
        <span className="truncate">{label}</span>
        <CaretDownIcon className="size-3 shrink-0" />
      </Button>
      {open && (
        <div className="absolute bottom-full end-0 z-30 mb-2 flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl bg-kumo-base shadow-lg ring ring-kumo-line">
          <div className="flex items-center gap-2 border-b border-kumo-hairline px-3 py-2">
            <MagnifyingGlassIcon className="size-4 shrink-0 text-kumo-subtle" />
            <input
              autoFocus
              value={query}
              placeholder="Search models..."
              aria-label="Search models"
              className="w-full bg-transparent text-sm outline-none placeholder:text-kumo-placeholder"
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
              className="flex max-h-80 w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-e border-kumo-hairline p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <button
                type="button"
                role="tab"
                aria-selected={providerFilter === "favorites"}
                aria-label="Favorites"
                title="Favorites"
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default",
                  providerFilter === "favorites" && "bg-kumo-tint text-kumo-strong",
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
                    "flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold uppercase text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default",
                    providerFilter === provider && "bg-kumo-tint text-kumo-strong",
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
                <p className="px-2 py-2 text-xs text-kumo-subtle">
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
                const recent = isNewModel(option.released);
                return (
                  <div
                    key={option.id}
                    className="group/model relative rounded-lg transition-colors hover:bg-kumo-tint"
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
                        {recent && (
                          <span className="shrink-0 text-[11px] font-medium text-kumo-strong">
                            New
                          </span>
                        )}
                        {tier && (
                          <span className="shrink-0 text-[11px] text-kumo-subtle">{tier}</span>
                        )}
                        {option.id === model && <CheckIcon className="size-3.5 shrink-0" />}
                      </span>
                      <span className="block truncate text-xs text-kumo-subtle">
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
                          : "text-kumo-inactive hover:text-kumo-default",
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
  onWatchDesktop,
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
  onWatchDesktop: () => void;
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
          <ChatPart
            key={index}
            part={part}
            role={message.role}
            onRespond={onRespond}
            onWatchDesktop={onWatchDesktop}
          />
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
                className="text-kumo-subtle"
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
                className="text-kumo-subtle"
                onClick={() => onFork(message, true)}
              />
            )}
            {usage && (
              <span className="text-[11px] text-kumo-subtle">{formatUsage(usage)}</span>
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
              className="text-kumo-subtle"
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
                className="text-kumo-subtle"
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
  onWatchDesktop,
}: {
  part: EveMessagePart;
  role: "assistant" | "user";
  onRespond: (requestId: string, optionId: string) => void;
  onWatchDesktop: () => void;
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
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs text-kumo-subtle hover:text-kumo-default [&::-webkit-details-marker]:hidden">
            <SparkleIcon className="size-3" aria-hidden />
            Reasoning
          </summary>
          <p className="mt-2 whitespace-pre-wrap border-s-2 border-kumo-hairline ps-3 text-xs text-kumo-subtle">
            {part.text}
          </p>
        </details>
      );

    case "file": {
      // Oversized inline payloads are stripped from the persisted transcript
      // (see compactChatForStorage); render those as a plain chip instead of
      // a link to a stub URL.
      const strippedFile = typeof part.url === "string" && isStrippedUrl(part.url);
      return (
        <Attachment size="sm" className="w-fit max-w-full">
          <AttachmentMedia>
            <FileIcon />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{part.filename ?? "Attachment"}</AttachmentTitle>
            <AttachmentDescription>{part.mediaType}</AttachmentDescription>
          </AttachmentContent>
          {part.url && !strippedFile && (
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
    }

    case "dynamic-tool": {
      const request = part.toolMetadata?.eve?.inputRequest;
      const label = part.toolName.replaceAll("_", " ");
      const running = part.state === "input-streaming" || part.state === "input-available";
      const expandable = part.input !== undefined || part.state === "output-available";
      // Screenshot tools (browser__screenshot, computer_screenshot) hand back
      // an inline image meant for the owner's eyes, not the model's: it only
      // exists here, so render it or nobody ever sees it.
      const image = part.state === "output-available" ? outputImageDataUrl(part.output) : null;

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
          <div className="flex items-start gap-1">
            {expandable ? (
              <details className="min-w-0">
                <summary className="w-fit cursor-pointer list-none rounded-md hover:brightness-125 [&::-webkit-details-marker]:hidden">
                  {marker}
                </summary>
                <div className="mt-2 flex flex-col gap-2 border-s-2 border-kumo-hairline ps-3">
                  <ToolPayload label="Input" value={part.input} />
                  {part.state === "output-available" && (
                    <ToolPayload label="Output" value={compactToolOutput(part.output)} />
                  )}
                </div>
              </details>
            ) : (
              marker
            )}
            {/* The desktop is the one tool whose work is worth watching live. */}
            {part.toolName.startsWith("computer_") && (
              <Button variant="ghost" size="sm" onClick={onWatchDesktop}>
                <MonitorIcon />
                Watch
              </Button>
            )}
          </div>
          {image !== null && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt={`${label} result`}
              className="h-auto w-fit max-w-full rounded-lg ring ring-kumo-hairline"
            />
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
                <KeyIcon className="size-4 text-kumo-subtle" aria-hidden />
                {part.displayName}
              </div>
              <p className="text-sm text-kumo-subtle">{part.description}</p>
              {part.authorization?.userCode && (
                <code className="w-fit rounded-md bg-kumo-tint px-2.5 py-1 font-mono text-sm tracking-widest">
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
