"use client";

import { CommandPalette as KumoCommandPalette, Loader } from "@cloudflare/kumo";
import {
  AlarmIcon,
  BellIcon,
  BellSlashIcon,
  BrainIcon,
  ChatCircleDotsIcon,
  ChatCircleIcon,
  CreditCardIcon,
  EnvelopeIcon,
  FileIcon,
  FilesIcon,
  GearSixIcon,
  HashIcon,
  LightningIcon,
  MagicWandIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  PhoneIcon,
  PlugsIcon,
  PlusIcon,
  SunIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import { AGENT_NAME } from "@/lib/identity";

// Global navigation palette (Cmd/Ctrl+K). This is deliberately separate from
// the composer's "/" palette: it navigates every app surface, jumps directly
// into Manage sections, toggles app-level actions, and searches conversations.

export interface PaletteThread {
  id: string;
  title: string;
  updatedAt: number;
}

export interface CommandPaletteFeatures {
  email: boolean;
  memory: boolean;
  proactive: boolean;
  integrations: boolean;
  skills: boolean;
  computerAvailable: boolean;
  cardAvailable: boolean;
  imessageAvailable: boolean;
  slackAvailable: boolean;
  phoneAvailable: boolean;
}

export type ManageSection =
  | "appearance"
  | "reminders"
  | "webhooks"
  | "memory"
  | "connections"
  | "skills"
  | "computer"
  | "card"
  | "imessage"
  | "slack"
  | "phone";

interface SearchHit {
  id: string;
  title: string;
  snippet: string | null;
}

interface PaletteEntry {
  id: string;
  category?: string;
  label: string;
  detail?: string;
  icon: React.ReactNode;
  keywords?: string[];
  href?: string;
  run: () => void;
}

function useFullTextSearch(query: string): {
  hits: SearchHit[];
  searching: boolean;
} {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setHits([]);
    setSearching(true);
    const timer = setTimeout(() => {
      void fetch(`/api/threads/search?q=${encodeURIComponent(needle)}`, {
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { results?: SearchHit[] } | null) => {
          if (!controller.signal.aborted) setHits(body?.results ?? []);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError")
            return;
          setHits([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return { hits, searching };
}

function matchesQuery(entry: PaletteEntry, needle: string): boolean {
  if (needle.length === 0) return true;
  const searchable = [entry.label, entry.detail, ...(entry.keywords ?? [])]
    .filter((part): part is string => part !== undefined)
    .join(" ")
    .toLocaleLowerCase();
  return needle.split(/\s+/).every((part) => searchable.includes(part));
}

function threadHref(threadId: string): string {
  const search = new URLSearchParams({ thread: threadId });
  return `/chat?${search}`;
}

function manageHref(section?: ManageSection): string {
  if (section === undefined) return "/manage";
  const search = new URLSearchParams({ tab: section });
  return `/manage?${search}`;
}

export function CommandPalette({
  open,
  onClose,
  threads,
  onSelectThread,
  onNewChat,
  onOpenChat,
  onOpenManage,
  onOpenEmail,
  onOpenFiles,
  onOpenWorkspace,
  onOpenArtifacts,
  onOpenDesktop,
  features,
  pushStatus,
  onTogglePush,
}: {
  open: boolean;
  onClose: () => void;
  threads: PaletteThread[];
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  onOpenChat: () => void;
  onOpenManage: (section?: ManageSection) => void;
  /** Omitted when this deployment has no email surface. */
  onOpenEmail?: () => void;
  onOpenFiles: () => void;
  onOpenWorkspace: () => void;
  onOpenArtifacts: () => void;
  /** Omitted until a desktop is configured. */
  onOpenDesktop?: () => void;
  features: CommandPaletteFeatures;
  /** "on" | "off" | "denied" | "unsupported" | "loading" from usePushNotifications. */
  pushStatus: string;
  onTogglePush: () => void;
}) {
  const [query, setQuery] = useState("");
  const { hits, searching } = useFullTextSearch(query);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const needle = query.trim().toLocaleLowerCase();
    const navigation: PaletteEntry[] = [
      {
        id: "navigation:chat",
        label: "Open chat",
        detail: "Return to the current conversation",
        icon: <ChatCircleIcon className="size-4" />,
        keywords: ["home", "conversation"],
        href: "/chat",
        run: onOpenChat,
      },
      ...(onOpenEmail === undefined
        ? []
        : [
            {
              id: "navigation:email",
              label: "Open email",
              detail: `${AGENT_NAME}'s inbox: read, search, send, and reply`,
              icon: <EnvelopeIcon className="size-4" />,
              keywords: ["inbox", "mail", "compose"],
              href: "/email",
              run: onOpenEmail,
            },
          ]),
      {
        id: "navigation:files",
        label: "Open files",
        detail: "Browse images and files uploaded in chat",
        icon: <FilesIcon className="size-4" />,
        keywords: ["uploads", "attachments", "documents"],
        href: "/files",
        run: onOpenFiles,
      },
      {
        id: "navigation:workspace",
        label: "Open workspace",
        detail: "Files, terminals, processes, ports, and sandbox controls",
        icon: <TerminalWindowIcon className="size-4" />,
        keywords: ["terminal", "code", "sandbox", "processes", "ports"],
        href: "/workspace",
        run: onOpenWorkspace,
      },
      {
        id: "navigation:artifacts",
        label: "Open artifacts workspace",
        detail: "Documents, revisions, comments, and shares",
        icon: <FileIcon className="size-4" />,
        keywords: ["documents", "drafts", "versions", "shares"],
        href: "/chat?desktop=1&workspace=artifacts",
        run: onOpenArtifacts,
      },
      ...(onOpenDesktop === undefined
        ? []
        : [
            {
              id: "navigation:desktop",
              label: `Open ${AGENT_NAME}'s desktop`,
              detail: "Watch the cloud computer live",
              icon: <MonitorIcon className="size-4" />,
              keywords: ["computer", "screen", "live view"],
              href: "/chat?desktop=1&workspace=computer",
              run: onOpenDesktop,
            },
          ]),
      {
        id: "navigation:manage",
        label: "Open Manage",
        detail: "Settings, automations, memory, connections, and capabilities",
        icon: <GearSixIcon className="size-4" />,
        keywords: ["settings", "preferences", "configuration"],
        href: manageHref(),
        run: () => onOpenManage(),
      },
      ...(features.imessageAvailable
        ? [
            {
              id: "navigation:imessage-log",
              label: "Open iMessage conversations",
              detail: "Browse the shared-number conversation log",
              icon: <ChatCircleDotsIcon className="size-4" />,
              keywords: ["messages", "transcript", "spectrum", "history"],
              href: "/imessage",
              run: () => window.location.assign("/imessage"),
            },
          ]
        : []),
    ];

    const manage: PaletteEntry[] = [
      {
        id: "manage:appearance",
        label: "Appearance",
        detail: "Choose light or dark mode",
        icon: <SunIcon className="size-4" />,
        keywords: ["theme", "display", "color mode", "settings"],
        href: manageHref("appearance"),
        run: () => onOpenManage("appearance"),
      },
      ...(features.proactive
        ? [
            {
              id: "manage:reminders",
              label: "Reminders",
              detail: "Review scheduled tasks and delivery",
              icon: <AlarmIcon className="size-4" />,
              keywords: ["schedule", "cron", "automation"],
              href: manageHref("reminders"),
              run: () => onOpenManage("reminders"),
            },
            {
              id: "manage:webhooks",
              label: "Triggers",
              detail: "Review event-triggered automations",
              icon: <LightningIcon className="size-4" />,
              keywords: ["webhooks", "events", "automation"],
              href: manageHref("webhooks"),
              run: () => onOpenManage("webhooks"),
            },
          ]
        : []),
      ...(features.memory
        ? [
            {
              id: "manage:memory",
              label: "Memory",
              detail: `Review what ${AGENT_NAME} remembers`,
              icon: <BrainIcon className="size-4" />,
              keywords: ["supermemory", "knowledge", "remember"],
              href: manageHref("memory"),
              run: () => onOpenManage("memory"),
            },
          ]
        : []),
      ...(features.integrations
        ? [
            {
              id: "manage:connections",
              label: "Connections",
              detail: "Connect and manage apps",
              icon: <PlugsIcon className="size-4" />,
              keywords: ["integrations", "composio", "apps", "oauth"],
              href: manageHref("connections"),
              run: () => onOpenManage("connections"),
            },
          ]
        : []),
      ...(features.skills
        ? [
            {
              id: "manage:skills",
              label: "Skills",
              detail: `Edit capabilities ${AGENT_NAME} has learned`,
              icon: <MagicWandIcon className="size-4" />,
              keywords: ["commands", "capabilities", "learned"],
              href: manageHref("skills"),
              run: () => onOpenManage("skills"),
            },
          ]
        : []),
      ...(features.computerAvailable
        ? [
            {
              id: "manage:computer",
              label: "Computer",
              detail: "Configure the cloud desktop and computer-use model",
              icon: <MonitorIcon className="size-4" />,
              keywords: ["desktop", "orgo", "screen", "model"],
              href: manageHref("computer"),
              run: () => onOpenManage("computer"),
            },
          ]
        : []),
      ...(features.cardAvailable
        ? [
            {
              id: "manage:card",
              label: "Card",
              detail: "Connect and manage Agentcard",
              icon: <CreditCardIcon className="size-4" />,
              keywords: ["agentcard", "payments", "wallet"],
              href: manageHref("card"),
              run: () => onOpenManage("card"),
            },
          ]
        : []),
      ...(features.imessageAvailable
        ? [
            {
              id: "manage:imessage",
              label: "iMessage",
              detail: "Pair and manage the shared iMessage channel",
              icon: <ChatCircleDotsIcon className="size-4" />,
              keywords: ["messages", "spectrum", "phone", "pair"],
              href: manageHref("imessage"),
              run: () => onOpenManage("imessage"),
            },
          ]
        : []),
      ...(features.slackAvailable
        ? [
            {
              id: "manage:slack",
              label: "Slack",
              detail: "Review setup and reaction rules",
              icon: <HashIcon className="size-4" />,
              keywords: ["channel", "messages", "reactions"],
              href: manageHref("slack"),
              run: () => onOpenManage("slack"),
            },
          ]
        : []),
      ...(features.phoneAvailable
        ? [
            {
              id: "manage:phone",
              label: "Phone",
              detail: "Provision and manage the agent phone",
              icon: <PhoneIcon className="size-4" />,
              keywords: ["calls", "number", "agentphone"],
              href: manageHref("phone"),
              run: () => onOpenManage("phone"),
            },
          ]
        : []),
    ];

    const actions: PaletteEntry[] = [
      {
        id: "action:new-chat",
        label: "New chat",
        detail: `Start a fresh conversation with ${AGENT_NAME}`,
        icon: <PlusIcon className="size-4" />,
        keywords: ["create", "conversation", "thread"],
        run: onNewChat,
      },
      ...(pushStatus === "on" || pushStatus === "off" || pushStatus === "denied"
        ? [
            {
              id: "action:push",
              label:
                pushStatus === "on"
                  ? "Disable notifications"
                  : "Enable notifications",
              detail:
                pushStatus === "denied"
                  ? "Notifications are blocked in browser settings"
                  : "Control proactive browser notifications",
              icon:
                pushStatus === "on" ? (
                  <BellSlashIcon className="size-4" />
                ) : (
                  <BellIcon className="size-4" />
                ),
              keywords: ["push", "alerts"],
              run: onTogglePush,
            },
          ]
        : []),
    ];

    const titleMatches = threads
      .filter(
        (thread) =>
          needle.length === 0 ||
          thread.title.toLocaleLowerCase().includes(needle),
      )
      .slice(0, needle.length === 0 ? 8 : 12)
      .map<PaletteEntry>((thread) => ({
        id: `thread:${thread.id}`,
        label: thread.title,
        detail: "Conversation",
        icon: <ChatCircleIcon className="size-4" />,
        href: threadHref(thread.id),
        run: () => onSelectThread(thread.id),
      }));

    const seen = new Set(
      titleMatches.map((entry) => entry.id.slice("thread:".length)),
    );
    const messageMatches = hits
      .filter((hit) => !seen.has(hit.id))
      .map<PaletteEntry>((hit) => ({
        id: `message:${hit.id}`,
        label: hit.title,
        detail: hit.snippet ?? "Matching conversation",
        icon: <MagnifyingGlassIcon className="size-4" />,
        href: threadHref(hit.id),
        run: () => onSelectThread(hit.id),
      }));

    return [
      {
        id: "navigation",
        label: "Navigation",
        items: navigation.filter((entry) => matchesQuery(entry, needle)),
      },
      {
        id: "manage",
        label: "Manage",
        items: manage.filter((entry) => matchesQuery(entry, needle)),
      },
      {
        id: "actions",
        label: "Actions",
        items: actions.filter((entry) => matchesQuery(entry, needle)),
      },
      { id: "threads", label: "Threads", items: titleMatches },
      { id: "messages", label: "In messages", items: messageMatches },
    ].flatMap((group) =>
      group.items.map((entry) => ({
        ...entry,
        category: group.label,
      })),
    );
  }, [
    features,
    hits,
    onNewChat,
    onOpenChat,
    onOpenDesktop,
    onOpenEmail,
    onOpenFiles,
    onOpenArtifacts,
    onOpenManage,
    onOpenWorkspace,
    onSelectThread,
    onTogglePush,
    pushStatus,
    query,
    threads,
  ]);

  function selectEntry(entry: PaletteEntry, newTab = false): void {
    if (newTab && entry.href !== undefined) {
      window.open(entry.href, "_blank", "noopener,noreferrer");
    } else {
      entry.run();
    }
    setQuery("");
    onClose();
  }

  return (
    <KumoCommandPalette.Root<PaletteEntry>
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      items={entries}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(entry) => entry.label}
      filter={() => true}
      getSelectableItems={(items) => items}
      onSelect={(entry, { newTab }) => selectEntry(entry, newTab)}
    >
      <KumoCommandPalette.Input
        placeholder="Search everything…"
        aria-label="Search commands, pages, settings, and conversations"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        data-1p-ignore="true"
        data-lpignore="true"
        trailing={searching ? <Loader size={14} /> : undefined}
      />
      <KumoCommandPalette.List>
        <KumoCommandPalette.Results>
          {(entry: PaletteEntry) => (
            <KumoCommandPalette.ResultItem
              key={entry.id}
              value={entry}
              title={entry.label}
              breadcrumbs={
                entry.category === undefined ? undefined : [entry.category]
              }
              description={entry.detail}
              icon={entry.icon}
              onClick={(event) => {
                selectEntry(entry, event.metaKey || event.ctrlKey);
              }}
            />
          )}
        </KumoCommandPalette.Results>
        <KumoCommandPalette.Empty>
          No commands or conversations found.
        </KumoCommandPalette.Empty>
      </KumoCommandPalette.List>
      <KumoCommandPalette.Footer>
        <span className="flex items-center gap-2">
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-[10px]">
            ↑↓
          </kbd>
          <span>Navigate</span>
        </span>
        <span className="flex items-center gap-2">
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-[10px]">
            ↵
          </kbd>
          <span>Open</span>
        </span>
        <span className="hidden items-center gap-2 sm:flex">
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-[10px]">
            ⌘/Ctrl ↵
          </kbd>
          <span>New tab</span>
        </span>
      </KumoCommandPalette.Footer>
    </KumoCommandPalette.Root>
  );
}
