"use client";

import type { HandleMessageStreamEvent, SessionState } from "eve/client";
import { useEveAgent } from "eve/react";
import type { EveMessage, EveMessagePart } from "eve/react";
import {
  ArrowUpIcon,
  CheckIcon,
  ExternalLinkIcon,
  FileIcon,
  KeyRoundIcon,
  PanelLeftIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  AttachmentContent,
  AttachmentDescription,
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

function putThreadToServer(meta: ThreadMeta, chat: SavedChat): void {
  void fetch(`/api/threads/${meta.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: meta.title, updatedAt: meta.updatedAt, chat }),
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
  useEffect(() => {
    const threadId = index.activeId;
    const local = loadSavedChat(threadId);
    if (local) {
      setActiveChat({ threadId, chat: local });
      return;
    }
    let cancelled = false;
    setActiveChat(null);
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

  const threads = [...index.threads].sort((a, b) => b.updatedAt - a.updatedAt);

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
        thread.id === id && thread.title !== title ? { ...thread, title } : thread,
      ),
    }));
  }

  function touchThread(id: string, title?: string) {
    setIndex((prev) => ({
      ...prev,
      threads: prev.threads.map((thread) =>
        thread.id === id
          ? { ...thread, updatedAt: Date.now(), ...(title ? { title } : {}) }
          : thread,
      ),
    }));
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
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          <ul className="flex flex-col gap-0.5">
            {threads.map((thread) => (
              <li key={thread.id} className="group/thread relative">
                <button
                  type="button"
                  onClick={() => selectThread(thread.id)}
                  className={cn(
                    "w-full rounded-md px-2.5 py-2 pe-8 text-start transition-colors hover:bg-sidebar-accent",
                    thread.id === index.activeId &&
                      "bg-sidebar-accent text-sidebar-accent-foreground",
                  )}
                >
                  <span className="block truncate text-sm">{thread.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatThreadDate(thread.updatedAt)}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${thread.title}`}
                  className="absolute end-1 top-1/2 -mt-3 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/thread:opacity-100"
                  onClick={() => {
                    setThreadToDelete(thread);
                    setDeleteDialogOpen(true);
                  }}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
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
          onOpenSidebar={() => setSidebarOpen(true)}
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

function ChatThread({
  threadId: _threadId,
  initialChat,
  onTitle,
  onActivity,
  onPersist,
  onOpenSidebar,
}: {
  threadId: string;
  initialChat: SavedChat;
  onTitle: (title: string) => void;
  onActivity: (title?: string) => void;
  onPersist: (chat: SavedChat) => void;
  onOpenSidebar: () => void;
}) {
  const [draft, setDraft] = useState("");

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

  function sendDraft() {
    const message = draft.trim();
    if (message.length === 0 || isBusy) return;
    setDraft("");
    onActivity(agent.data.messages.length === 0 ? toThreadTitle(message) : undefined);
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

  const hasMessages = agent.data.messages.length > 0;
  // Keep the thinking indicator up until the reply has something to show;
  // reasoning models can stream for a while before any visible output.
  const lastMessage = agent.data.messages.at(-1);
  const showThinking =
    isBusy && (lastMessage?.role !== "assistant" || !hasVisibleParts(lastMessage));

  return (
    <main className="relative flex h-dvh min-w-0 flex-1 flex-col">
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
                    <ChatMessage message={message} onRespond={respondToInput} />
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

        <footer className="pb-4 pt-2">
          <form
            className="flex items-end gap-2 rounded-2xl border bg-card p-2 ps-4 transition-colors focus-within:border-ring"
            onSubmit={(event) => {
              event.preventDefault();
              sendDraft();
            }}
          >
            <Textarea
              value={draft}
              placeholder="Message Eve..."
              rows={1}
              className="max-h-44 min-h-0 resize-none border-0 bg-transparent p-0 py-1.5 shadow-none [field-sizing:content] focus-visible:ring-0 dark:bg-transparent"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendDraft();
                }
              }}
            />
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
              <Button type="submit" size="icon" aria-label="Send" disabled={draft.trim().length === 0}>
                <ArrowUpIcon />
              </Button>
            )}
          </form>
        </footer>
      </div>
    </main>
  );
}

function ChatMessage({
  message,
  onRespond,
}: {
  message: EveMessage;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  const align = message.role === "user" ? "end" : "start";
  return (
    <Message align={align}>
      <MessageContent className="gap-2">
        {message.parts.map((part, index) => (
          <ChatPart key={index} part={part} role={message.role} onRespond={onRespond} />
        ))}
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

      return (
        <div className="flex flex-col gap-2">
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
