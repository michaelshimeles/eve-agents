"use client";

import { Loader } from "@cloudflare/kumo";
import {
  BellIcon,
  BellSlashIcon,
  ChatCircleIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// Navigation command palette (Cmd+K): jump to threads, start a new chat,
// open the manage panel, toggle notifications. Complements the composer's
// "/" palette, which inserts prompts. Thread titles filter locally; from two
// characters the server's full-text index is also searched so old
// conversations surface by what was said in them.

export interface PaletteThread {
  id: string;
  title: string;
  updatedAt: number;
}

interface SearchHit {
  id: string;
  title: string;
  snippet: string | null;
}

interface PaletteEntry {
  key: string;
  kind: "action" | "thread" | "message";
  label: string;
  detail?: string;
  icon?: React.ReactNode;
  run: () => void;
}

function useFullTextSearch(query: string): { hits: SearchHit[]; searching: boolean } {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void fetch(`/api/threads/search?q=${encodeURIComponent(needle)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { results?: SearchHit[] } | null) => setHits(body?.results ?? []))
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  return { hits, searching };
}

export function CommandPalette({
  open,
  onClose,
  threads,
  onSelectThread,
  onNewChat,
  onOpenManage,
  pushStatus,
  onTogglePush,
}: {
  open: boolean;
  onClose: () => void;
  threads: PaletteThread[];
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  onOpenManage: () => void;
  /** "on" | "off" | "denied" | "unsupported" | "loading" from usePushNotifications. */
  pushStatus: string;
  onTogglePush: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { hits, searching } = useFullTextSearch(query);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Focus after the overlay paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const needle = query.trim().toLowerCase();
    const list: PaletteEntry[] = [];

    const actions: PaletteEntry[] = [
      {
        key: "action:new",
        kind: "action",
        label: "New chat",
        icon: <PlusIcon className="size-4" />,
        run: () => {
          onNewChat();
          onClose();
        },
      },
      {
        key: "action:manage",
        kind: "action",
                label: "Open manage page",
        detail: "Reminders, triggers, memory, connections, skills",
        icon: <GearSixIcon className="size-4" />,
        run: () => {
          onOpenManage();
          onClose();
        },
      },
      ...(pushStatus === "on" || pushStatus === "off" || pushStatus === "denied"
        ? [
            {
              key: "action:push",
              kind: "action" as const,
              label: pushStatus === "on" ? "Disable notifications" : "Enable notifications",
              icon:
                pushStatus === "on" ? (
                  <BellSlashIcon className="size-4" />
                ) : (
                  <BellIcon className="size-4" />
                ),
              run: () => {
                onTogglePush();
                onClose();
              },
            },
          ]
        : []),
    ];
    list.push(
      ...actions.filter(
        (action) => needle.length === 0 || action.label.toLowerCase().includes(needle),
      ),
    );

    const titleMatches = threads
      .filter((thread) => needle.length === 0 || thread.title.toLowerCase().includes(needle))
      .slice(0, needle.length === 0 ? 8 : 12);
    list.push(
      ...titleMatches.map((thread) => ({
        key: `thread:${thread.id}`,
        kind: "thread" as const,
        label: thread.title,
        icon: <ChatCircleIcon className="size-4" />,
        run: () => {
          onSelectThread(thread.id);
          onClose();
        },
      })),
    );

    const seen = new Set(titleMatches.map((thread) => thread.id));
    list.push(
      ...hits
        .filter((hit) => !seen.has(hit.id))
        .map((hit) => ({
          key: `message:${hit.id}`,
          kind: "message" as const,
          label: hit.title,
          detail: hit.snippet ?? undefined,
          icon: <MagnifyingGlassIcon className="size-4" />,
          run: () => {
            onSelectThread(hit.id);
            onClose();
          },
        })),
    );

    return list;
  }, [query, threads, hits, pushStatus, onNewChat, onOpenManage, onTogglePush, onSelectThread, onClose]);

  const active = Math.min(activeIndex, Math.max(0, entries.length - 1));

  if (!open) return null;

  let lastKind: string | null = null;
  const sectionLabel: Record<PaletteEntry["kind"], string> = {
    action: "Actions",
    thread: "Threads",
    message: "In messages",
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[16vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="flex max-h-[55vh] w-[36rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl bg-kumo-base shadow-xl ring ring-kumo-line"
      >
        <div className="flex items-center gap-2 border-b border-kumo-hairline px-4 py-3">
          <MagnifyingGlassIcon className="size-4 shrink-0 text-kumo-subtle" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search threads and messages..."
            aria-label="Search threads and messages"
            className="w-full bg-transparent text-sm outline-none placeholder:text-kumo-placeholder"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((active + 1) % Math.max(1, entries.length));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((active - 1 + entries.length) % Math.max(1, entries.length));
              } else if (event.key === "Enter" && entries[active]) {
                event.preventDefault();
                entries[active].run();
              }
            }}
          />
          {searching && <Loader size={14} />}
        </div>
        <div className="overflow-y-auto p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {entries.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-kumo-subtle">No matches.</p>
          )}
          {entries.map((entry, index) => {
            const header = entry.kind !== lastKind ? sectionLabel[entry.kind] : null;
            lastKind = entry.kind;
            return (
              <div key={entry.key}>
                {header && (
                  <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-kumo-subtle">
                    {header}
                  </p>
                )}
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start",
                    index === active && "bg-kumo-tint",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={entry.run}
                >
                  <span className="shrink-0 text-kumo-subtle">{entry.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{entry.label}</span>
                    {entry.detail && (
                      <span className="block truncate text-xs text-kumo-subtle">
                        {entry.detail}
                      </span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <p className="border-t border-kumo-hairline px-4 py-2 text-[11px] text-kumo-subtle">
          ↑↓ navigate · Enter select · Esc close
        </p>
      </div>
    </div>
  );
}
