"use client";

import type { UserContent } from "ai";
import type { HandleMessageStreamEvent, SessionState } from "eve/client";
import { useEveAgent } from "eve/react";
import type { EveMessage, EveMessagePart } from "eve/react";
import {
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileIcon,
  KeyRoundIcon,
  MicIcon,
  PanelLeftIcon,
  PaperclipIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Markdown } from "@/components/markdown";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const THREADS_KEY = "eve-web-threads";
const LEGACY_CHAT_KEY = "eve-web-chat";

function chatKey(threadId: string): string {
  return `eve-web-chat:${threadId}`;
}

interface SavedChat {
  events?: readonly HandleMessageStreamEvent[];
  session?: SessionState;
}

interface ThreadMeta {
  id: string;
  title: string;
  updatedAt: number;
  pinned?: boolean;
  /** Set once the user renames a thread, so auto-titles stop overwriting it. */
  renamed?: boolean;
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
    localStorage.setItem(chatKey(threadId), JSON.stringify(chat));
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
      size="icon-xs"
      aria-label={label}
      className="text-muted-foreground hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
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
      <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
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

function sectionThreads(threads: ThreadMeta[], query: string): ThreadSection[] {
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  const needle = query.trim().toLowerCase();
  if (needle.length > 0) {
    return [
      { label: null, threads: sorted.filter((t) => t.title.toLowerCase().includes(needle)) },
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

export function Chat() {
  // localStorage is read in useState initializers, so only mount the chat
  // on the client to avoid an SSR/hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <main className="h-dvh bg-background" />;
  }
  return <ChatApp />;
}

function ChatApp() {
  const [index, setIndex] = useState<ThreadIndex>(loadThreadIndex);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The thread meta is kept separately from the open flag so the dialog's
  // text doesn't blank out during its closing animation.
  const [threadToDelete, setThreadToDelete] = useState<ThreadMeta | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  // The active thread's chat payload; null while it loads from the server.
  const [activeChat, setActiveChat] = useState<{ threadId: string; chat: SavedChat } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  // Threads with a turn still running, so background threads get a dot.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  // Slash-command palette: built-ins plus skills saved from chat.
  const [commands, setCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS);

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
  // the server doesn't know about yet.
  useEffect(() => {
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
          if (!existing || thread.updatedAt > existing.updatedAt) byId.set(thread.id, thread);
        }
        const threads = [...byId.values()];
        const activeId = threads.some((thread) => thread.id === prev.activeId)
          ? prev.activeId
          : [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
        return { activeId, threads };
      });
    });
  }, []);

  // Resolve the active thread's chat: localStorage first, then the server
  // (for threads that live on another device or after cleared storage).
  // Local hits resolve during render so switching threads never paints the
  // intermediate spinner frame.
  if (activeChat?.threadId !== index.activeId) {
    const local = loadSavedChat(index.activeId);
    if (local) setActiveChat({ threadId: index.activeId, chat: local });
  }
  useEffect(() => {
    const threadId = index.activeId;
    if (loadSavedChat(threadId)) return;
    let cancelled = false;
    void fetchServerChat(threadId).then((chat) => {
      if (cancelled) return;
      if (chat) saveLocalChat(threadId, chat);
      setActiveChat({ threadId, chat: chat ?? {} });
    });
    return () => {
      cancelled = true;
    };
  }, [index.activeId]);

  function persistChat(threadId: string, chat: SavedChat) {
    saveLocalChat(threadId, chat);
    const meta = indexRef.current.threads.find((thread) => thread.id === threadId);
    if (meta) putThreadToServer(meta, chat);
  }

  const sections = sectionThreads(index.threads, searchQuery);

  function newThread() {
    const meta = newThreadMeta();
    // Seed the local chat so the new thread renders without a server probe.
    saveLocalChat(meta.id, {});
    setIndex((prev) => ({ activeId: meta.id, threads: [meta, ...prev.threads] }));
    setSidebarOpen(false);
  }

  function selectThread(id: string) {
    setIndex((prev) => ({ ...prev, activeId: id }));
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
          "fixed inset-y-0 start-0 z-40 flex w-64 shrink-0 -translate-x-full flex-col border-e bg-sidebar text-sidebar-foreground transition-transform duration-200 md:static md:translate-x-0",
          sidebarOpen && "translate-x-0",
        )}
      >
        <div className="flex items-center justify-between px-3 py-3">
          <span className="text-sm font-semibold tracking-tight">Eve</span>
          <Button variant="ghost" size="icon-sm" aria-label="New thread" onClick={newThread}>
            <PlusIcon />
          </Button>
        </div>
        <div className="px-2 pb-2">
          <div className="flex items-center gap-1.5 rounded-md border bg-background px-2 transition-colors focus-within:border-ring">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={searchQuery}
              placeholder="Search threads"
              aria-label="Search threads"
              className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            {searchQuery.length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                className="text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setSearchQuery("")}
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {sections.every((section) => section.threads.length === 0) && (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">No threads match.</p>
          )}
          {sections.map((section) => (
            <div key={section.label ?? "results"} className="pb-2">
              {section.label && (
                <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground">
                  {section.label}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
                {section.threads.map((thread) => (
                  <SidebarThread
                    key={thread.id}
                    thread={thread}
                    active={thread.id === index.activeId}
                    busy={busyIds.has(thread.id)}
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

      {activeChat && activeChat.threadId === index.activeId ? (
        <ChatThread
          key={index.activeId}
          threadId={index.activeId}
          initialChat={activeChat.chat}
          onTitle={(title) => setThreadTitle(index.activeId, title)}
          onActivity={(title) => touchThread(index.activeId, title)}
          onPersist={(chat) => persistChat(index.activeId, chat)}
          onBusyChange={(busy) => setThreadBusy(index.activeId, busy)}
          onOpenSidebar={() => setSidebarOpen(true)}
          commands={commands}
        />
      ) : (
        <main className="flex h-dvh min-w-0 flex-1 items-center justify-center">
          <Spinner className="text-muted-foreground" />
        </main>
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete thread?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{threadToDelete?.title}&rdquo; and its local history will be removed. This
              can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (threadToDelete) deleteThread(threadToDelete.id);
                setDeleteDialogOpen(false);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SidebarThread({
  thread,
  active,
  busy,
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
          className="w-full rounded-md bg-sidebar-accent px-2.5 py-2 text-sm text-sidebar-accent-foreground outline-none ring-1 ring-ring"
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
          "w-full rounded-md px-2.5 py-2 pe-8 text-start transition-colors group-hover/thread:bg-sidebar-accent",
          active && "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
      >
        <span className="relative flex items-center">
          {busy && (
            <span
              className="absolute -start-1 size-1.5 shrink-0 -translate-x-full animate-pulse rounded-full bg-primary"
              role="status"
              aria-label="Turn in progress"
            />
          )}
          <span className="truncate text-sm">{thread.title}</span>
        </span>
        <span className="block text-xs text-muted-foreground">
          {formatThreadDate(thread.updatedAt)}
        </span>
      </button>
      <div className="absolute end-1 top-1/2 flex -translate-y-1/2 items-center rounded-md bg-sidebar-accent opacity-0 transition-opacity focus-within:opacity-100 group-hover/thread:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={thread.pinned ? `Unpin ${thread.title}` : `Pin ${thread.title}`}
          onClick={onTogglePin}
        >
          {thread.pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Rename ${thread.title}`}
          onClick={onStartRename}
        >
          <PencilIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${thread.title}`}
          onClick={onDelete}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

function ChatThread({
  threadId: _threadId,
  initialChat,
  onTitle,
  onActivity,
  onPersist,
  onBusyChange,
  onOpenSidebar,
  commands,
}: {
  threadId: string;
  initialChat: SavedChat;
  onTitle: (title: string) => void;
  onActivity: (title?: string) => void;
  onPersist: (chat: SavedChat) => void;
  onBusyChange: (busy: boolean) => void;
  onOpenSidebar: () => void;
  commands: SlashCommand[];
}) {
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);

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

  const hasMessages = agent.data.messages.length > 0;
  const lastUserId = agent.data.messages.findLast((message) => message.role === "user")?.id;
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
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-xl border-2 border-dashed border-ring px-8 py-6 text-sm font-medium">
            <PaperclipIcon className="size-4" />
            Drop files to attach
          </div>
        </div>
      )}
      <div className="mx-auto flex size-full max-w-3xl min-h-0 flex-col px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute start-2 top-2 z-20 md:hidden"
          aria-label="Open threads"
          onClick={onOpenSidebar}
        >
          <PanelLeftIcon />
        </Button>

        <MessageScrollerProvider autoScroll>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport className="[scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
              <MessageScrollerContent className="gap-5 py-6">
                {!hasMessages && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-1.5 text-center">
                    <p className="text-xl font-semibold">Hey Micky.</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
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
                      showUserActions={message.id === lastUserId && !isBusy}
                      onEdit={editMessage}
                      onRetry={retryMessage}
                      onRespond={respondToInput}
                    />
                  </MessageScrollerItem>
                ))}
                {showThinking && (
                  <MessageScrollerItem messageId="thinking">
                    <Marker role="status">
                      <MarkerIcon>
                        <Spinner />
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
              className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded-xl border bg-popover shadow-lg"
            >
              <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground">
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
                      "flex w-full items-baseline gap-2 px-3 py-2 text-start text-sm transition-colors",
                      commandIndex === activePaletteIndex && "bg-accent text-accent-foreground",
                    )}
                    // Keep the textarea focused; the click still fires.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setPaletteIndex(commandIndex)}
                    onClick={() => applyCommand(command)}
                  >
                    <span className="shrink-0 font-mono text-xs font-medium">/{command.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {command.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <form
            className="rounded-2xl border bg-card p-2 transition-colors focus-within:border-ring"
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
                        onClick={() => removeAttachment(attachment.id)}
                      >
                        <XIcon />
                      </AttachmentAction>
                    </AttachmentActions>
                  </Attachment>
                ))}
              </AttachmentGroup>
            )}
            <div className="flex items-end gap-2 ps-2">
              <Textarea
                ref={composerRef}
                value={draft}
                placeholder="Message Eve... (/ for commands)"
                rows={1}
                className="max-h-44 min-h-0 resize-none border-0 bg-transparent p-0 py-1.5 shadow-none [field-sizing:content] focus-visible:ring-0 dark:bg-transparent"
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
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Attach files"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
              >
                <PaperclipIcon />
              </Button>
              {speechSupported && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={listening ? "Stop voice input" : "Start voice input"}
                  className={cn(
                    "text-muted-foreground hover:text-foreground",
                    listening && "animate-pulse text-red-500 hover:text-red-500",
                  )}
                  onClick={toggleVoice}
                >
                  <MicIcon />
                </Button>
              )}
              {isBusy ? (
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  aria-label="Stop"
                  onClick={() => void stopTurn()}
                >
                  <SquareIcon className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send"
                  disabled={draft.trim().length === 0 && attachments.length === 0}
                >
                  <ArrowUpIcon />
                </Button>
              )}
            </div>
          </form>
          <p className="h-6 pt-2 text-center text-[11px] text-muted-foreground">
            {threadUsage.inputTokens > 0 ? `${formatUsage(threadUsage)} this thread` : "\u00A0"}
          </p>
        </footer>
      </div>
    </main>
  );
}

function ChatMessage({
  message,
  usage,
  showUserActions,
  onEdit,
  onRetry,
  onRespond,
}: {
  message: EveMessage;
  usage?: TurnUsage;
  showUserActions: boolean;
  onEdit: (text: string) => void;
  onRetry: (text: string) => void;
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
            {usage && (
              <span className="text-[11px] text-muted-foreground">{formatUsage(usage)}</span>
            )}
          </div>
        )}
        {message.role === "user" && text.length > 0 && (
          <div className={cn(actionRowClass, "justify-end", !showUserActions && "invisible")}>
            <CopyButton text={text} />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Edit and resend"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onEdit(text)}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Retry"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onRetry(text)}
            >
              <RefreshCwIcon />
            </Button>
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
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <SparklesIcon className="size-3" aria-hidden />
            Reasoning
          </summary>
          <p className="mt-2 whitespace-pre-wrap border-s-2 ps-3 text-xs text-muted-foreground">
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
              <Spinner />
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
              <summary className="w-fit cursor-pointer list-none rounded-md transition-colors hover:brightness-125 [&::-webkit-details-marker]:hidden">
                {marker}
              </summary>
              <div className="mt-2 flex flex-col gap-2 border-s-2 ps-3">
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
                              ? "default"
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
                <KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden />
                {part.displayName}
              </div>
              <p className="text-sm text-muted-foreground">{part.description}</p>
              {part.authorization?.userCode && (
                <code className="w-fit rounded-md bg-muted px-2.5 py-1 font-mono text-sm tracking-widest">
                  {part.authorization.userCode}
                </code>
              )}
              {part.authorization?.url && (
                <Button
                  size="sm"
                  className="w-fit"
                  render={
                    <a href={part.authorization.url} target="_blank" rel="noreferrer" />
                  }
                >
                  Sign in
                  <ExternalLinkIcon />
                </Button>
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
