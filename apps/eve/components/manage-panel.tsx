"use client";

import {
  Badge,
  Button,
  Combobox,
  DropdownMenu,
  Input,
  InputArea,
  Loader,
  Radio,
} from "@cloudflare/kumo";
import {
  AlarmIcon,
  ArrowSquareOutIcon,
  BrainIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChatCircleDotsIcon,
  CheckIcon,
  CommandIcon,
  CopyIcon,
  CreditCardIcon,
  HashIcon,
  LightningIcon,
  MagicWandIcon,
  MonitorIcon,
  PencilSimpleIcon,
  PhoneIcon,
  PlugsIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SunIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { AppearancePanel } from "@/components/appearance-panel";
import { CardPanel } from "@/components/card-panel";
import { ComputerViewer } from "@/components/computer-viewer";
import { IMessagePanel } from "@/components/imessage-panel";
import { LocalComputerPanel } from "@/components/local-computer-panel";
import { PhoneComingSoon } from "@/components/phone-panel";
import { SlackPanel } from "@/components/slack-panel";
import { AGENT_NAME } from "@/lib/identity";
import { cn } from "@/lib/utils";

// Management surface for everything Ruth does or knows on her own: scheduled
// reminders, event-trigger webhooks, long-term memory, connected apps, and
// saved skills. Reminders/webhooks/memory stay read + delete (creation is
// conversational); connections can be added/removed here because that's an
// OAuth flow, and skills are editable since they're plain markdown.
// Owns the whole manage surface: a sections sidebar that takes the thread
// sidebar's slot (same width, surface, and off-canvas mobile behavior — the
// thread list hides while this view is up) and the selected section's content
// on the right. Rendered by the /manage page.

/**
 * The open section rides in the URL (`?tab=<value>`), matching how the shell
 * records the view, open thread, and desktop panel: a reload or a shared
 * link lands on the same section, and back/forward walk through section
 * switches. Clicks push it; a catch-all effect keeps it in step when the
 * section changes some other way (an absent feature's fallback).
 */
const TAB_PARAM = "tab";

function tabFromLocation(): string | null {
  return new URLSearchParams(window.location.search).get(TAB_PARAM);
}

interface ReminderItem {
  id: number;
  prompt: string;
  cron: string | null;
  timezone: string;
  nextFireAt: string;
  lastFiredAt: string | null;
}

interface WebhookItem {
  id: string;
  name: string;
  prompt: string;
  url: string;
  fireCount: number;
  lastFiredAt: string | null;
}

interface RunItem {
  id: number;
  kind: "reminder" | "webhook";
  automationId: string;
  firedAt: string;
  status: "ok" | "error";
  error: string | null;
  threadId: string | null;
}

type DeliveryTarget = "origin" | "web" | "telegram" | "imessage" | "slack";

interface DeliveryView {
  target: DeliveryTarget;
  telegramLinked: boolean;
  imessagePaired: boolean;
  slackLinked: boolean;
}

const DELIVERY_LABELS: Record<DeliveryTarget, string> = {
  origin: "Where created",
  web: "Web chat",
  telegram: "Telegram",
  imessage: "iMessage",
  slack: "Slack",
};

interface MemoryItem {
  id: string;
  content: string;
  permanent: boolean;
  updatedAt: string | null;
}

interface ConnectionItem {
  toolkit: string;
  name: string;
  accounts: {
    id: string;
    status: string;
    alias: string | null;
    label: string | null;
  }[];
}

interface ToolkitOption {
  slug: string;
  name: string;
}

interface SkillItem {
  name: string;
  description: string;
  markdown: string;
  updatedAt: string;
}

function formatWhen(iso: string | null): string {
  if (iso === null) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Two-step destructive button: first click arms it, second click fires. */
function DeleteButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  const [arming, setArming] = useState(false);

  useEffect(() => {
    if (!arming) return;
    const timer = setTimeout(() => setArming(false), 3000);
    return () => clearTimeout(timer);
  }, [arming]);

  if (arming) {
    return (
      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          setArming(false);
          onDelete();
        }}
      >
        Confirm
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={TrashIcon}
      aria-label={label}
      title={label}
      onClick={() => setArming(true)}
    />
  );
}

function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={copied ? CheckIcon : CopyIcon}
      aria-label="Copy webhook URL"
      title="Copy webhook URL"
      onClick={() => {
        void navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-kumo-subtle">{children}</p>;
}

function LoadingRow() {
  return (
    <div className="flex justify-center py-8">
      <Loader size={18} />
    </div>
  );
}

/** Recent fires for one automation, with links to the delivered threads. */
function RunHistory({
  runs,
  onOpenThread,
}: {
  runs: RunItem[];
  onOpenThread: (threadId: string) => void;
}) {
  if (runs.length === 0) {
    return <p className="pb-2 ps-6 text-xs text-kumo-subtle">No runs recorded yet.</p>;
  }
  return (
    <ul className="mb-2 flex flex-col gap-1 ps-6">
      {runs.slice(0, 5).map((run) => (
        <li key={run.id} className="flex items-center gap-2 text-xs">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              run.status === "ok" ? "bg-kumo-success" : "bg-kumo-danger",
            )}
            aria-hidden
          />
          <span className="text-kumo-subtle">{formatWhen(run.firedAt)}</span>
          {run.status === "error" && (
            <span className="truncate text-kumo-danger" title={run.error ?? undefined}>
              {run.error ?? "failed"}
            </span>
          )}
          {run.threadId !== null && (
            <button
              type="button"
              className="flex items-center gap-1 text-kumo-interact hover:underline"
              onClick={() => onOpenThread(run.threadId!)}
            >
              Open thread
              <ArrowSquareOutIcon className="size-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Where reminder and trigger results get delivered. "Where created" is the
 * default (Telegram-created automations reply into that DM, web-created ones
 * land as web chat threads); an explicit choice pins every result to one
 * place. Unavailable choices fall back to web chat, called out in the hint.
 */
function DeliveryPicker({
  delivery,
  onChange,
}: {
  delivery: DeliveryView;
  onChange: (target: DeliveryTarget) => void;
}) {
  const hint =
    delivery.target === "telegram" && !delivery.telegramLinked
      ? "No Telegram chat is linked yet — results land in web chat until you message the bot once."
      : delivery.target === "imessage" && !delivery.imessagePaired
        ? "No iMessage number is paired — results land in web chat. Pair one under the iMessage tab."
        : delivery.target === "slack" && !delivery.slackLinked
          ? "No Slack DM is linked yet — results land in web chat until you message the bot once."
          : null;
  return (
    <div className="mb-5 flex flex-col gap-2 border-b border-kumo-hairline pb-4">
      <span className="text-xs text-kumo-subtle">Deliver reminder and trigger results to</span>
      <Radio.Group<DeliveryTarget>
        orientation="horizontal"
        value={delivery.target}
        onValueChange={(value) => onChange(value)}
      >
        {/* The visible label is the span above; keep an invisible legend so
            the group still announces itself to assistive tech. */}
        <Radio.Legend className="sr-only">Deliver reminder and trigger results to</Radio.Legend>
        {(Object.entries(DELIVERY_LABELS) as [DeliveryTarget, string][]).map(([value, label]) => (
          <Radio.Item<DeliveryTarget>
            key={value}
            label={label}
            value={value}
            // Kumo has no small radio: dial the stock 16px control (a span
            // with data-kumo-part="item", not a button) and text-base label
            // down to sit with this section's text-xs scale.
            className="[&>span]:text-sm [&>[data-kumo-part=item]]:mt-[3px] [&>[data-kumo-part=item]]:size-3.5 [&>[data-kumo-part=item]_span]:size-1.5"
          />
        ))}
      </Radio.Group>
      {hint !== null && <p className="text-xs text-kumo-subtle">{hint}</p>}
    </div>
  );
}

function ExpandCaret({ expanded, onToggle, label }: { expanded: boolean; onToggle: () => void; label: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={expanded ? CaretDownIcon : CaretRightIcon}
      aria-label={label}
      aria-expanded={expanded}
      title={label}
      onClick={onToggle}
    />
  );
}

// --- Connections tab ---

/**
 * Composio-hosted brand logo for a toolkit, on a small white tile so dark
 * marks (GitHub, Notion) stay visible in dark mode. Falls back to the plug
 * icon if the CDN has no logo for the slug.
 */
function ToolkitLogo({ toolkit }: { toolkit: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <PlugsIcon className="size-4 shrink-0 text-kumo-subtle" aria-hidden />;
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white p-[3px]">
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny external SVG, not worth the image pipeline */}
      <img
        src={`https://logos.composio.dev/api/${toolkit}`}
        alt=""
        className="size-full object-contain"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function ConnectionsTab() {
  const [connections, setConnections] = useState<ConnectionItem[] | null>(null);
  const [available, setAvailable] = useState<ToolkitOption[]>([]);
  const [failed, setFailed] = useState(false);
  const [pendingToolkit, setPendingToolkit] = useState<string | null>(null);
  const [catalogComplete, setCatalogComplete] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  function load() {
    void fetch("/api/connections")
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          body: {
            connections?: ConnectionItem[];
            toolkits?: ToolkitOption[];
            catalogComplete?: boolean;
          } | null,
        ) => {
          if (body === null) {
            setFailed(true);
            setConnections([]);
            return;
          }
          setFailed(false);
          const connected = new Set((body.connections ?? []).map((entry) => entry.toolkit));
          setConnections(body.connections ?? []);
          setAvailable((body.toolkits ?? []).filter((toolkit) => !connected.has(toolkit.slug)));
          setCatalogComplete(body.catalogComplete ?? true);
        },
      )
      .catch(() => {
        setFailed(true);
        setConnections([]);
      });
  }

  useEffect(load, []);

  function connect(toolkit: string) {
    setPendingToolkit(toolkit);
    setConnectionError(null);
    void fetch("/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<{ url: string }>;
      })
      .then(({ url }) => {
        window.open(url, "_blank", "noopener");
      })
      .catch((error: unknown) => {
        setConnectionError(error instanceof Error ? error.message : "Connect failed");
      })
      .finally(() => setPendingToolkit(null));
  }

  function disconnect(toolkit: string, accountId: string) {
    setConnections(
      (prev) =>
        prev?.map((entry) =>
          entry.toolkit === toolkit
            ? { ...entry, accounts: entry.accounts.filter((account) => account.id !== accountId) }
            : entry,
        ) ?? null,
    );
    void fetch("/api/connections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit, accountId }),
    });
  }

  if (connections === null) return <LoadingRow />;

  return (
    <div className="flex flex-col gap-3">
      {failed && (
        <EmptyNote>Couldn&rsquo;t reach Composio. Check COMPOSIO_API_KEY and retry.</EmptyNote>
      )}
      {!failed && connections.length === 0 && (
        <EmptyNote>No connected apps yet. Connect one below or ask {AGENT_NAME} in chat.</EmptyNote>
      )}
      {connections.filter((entry) => entry.accounts.length > 0).length > 0 && (
        <ul className="flex flex-col">
          {connections
            .filter((entry) => entry.accounts.length > 0)
            .map((entry) => (
              <li
                key={entry.toolkit}
                className="border-b border-kumo-hairline py-2.5 last:border-b-0"
              >
                <div className="flex items-center gap-2">
                  <ToolkitLogo toolkit={entry.toolkit} />
                  <span className="text-sm font-medium">{entry.name}</span>
                </div>
                <ul className="mt-1 flex flex-col gap-1">
                  {entry.accounts.map((account) => (
                    <li key={account.id} className="flex items-center gap-2 ps-6">
                      <span className="min-w-0 flex-1 truncate text-xs text-kumo-subtle">
                        {account.alias ?? account.label ?? account.id}
                      </span>
                      <Badge variant={account.status === "active" ? "success" : "secondary"}>
                        {account.status}
                      </Badge>
                      <DeleteButton
                        label={`Disconnect ${entry.toolkit}`}
                        onDelete={() => disconnect(entry.toolkit, account.id)}
                      />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
        </ul>
      )}
      {!failed && available.length > 0 && (
        <div className="max-w-sm pt-1">
          <Combobox<ToolkitOption>
            items={available}
            value={null}
            disabled={pendingToolkit !== null}
            autoHighlight
            itemToStringLabel={(toolkit) => toolkit.name}
            itemToStringValue={(toolkit) => toolkit.slug}
            isItemEqualToValue={(item, value) => item.slug === value.slug}
            filter={(toolkit, query) => {
              const needle = query.trim().toLowerCase();
              return (
                needle.length === 0 ||
                toolkit.name.toLowerCase().includes(needle) ||
                toolkit.slug.toLowerCase().includes(needle)
              );
            }}
            onValueChange={(toolkit) => {
              if (toolkit !== null) connect(toolkit.slug);
            }}
          >
            <Combobox.TriggerInput
              aria-label="Search Composio apps to connect"
              placeholder={
                pendingToolkit === null
                  ? `Search ${available.length.toLocaleString()} apps…`
                  : "Opening connection…"
              }
            />
            <Combobox.Content align="start">
              <Combobox.List className="max-h-72">
                {(toolkit) => (
                  <Combobox.Item key={toolkit.slug} value={toolkit}>
                    <span className="flex min-w-0 items-center gap-2">
                      <ToolkitLogo toolkit={toolkit.slug} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{toolkit.name}</span>
                        <span className="block truncate text-xs text-kumo-subtle">
                          {toolkit.slug}
                        </span>
                      </span>
                    </span>
                  </Combobox.Item>
                )}
              </Combobox.List>
              <Combobox.Empty>No Composio apps match that search.</Combobox.Empty>
            </Combobox.Content>
          </Combobox>
          {connectionError !== null && (
            <p className="pt-2 text-pretty text-xs text-kumo-danger">{connectionError}</p>
          )}
        </div>
      )}
      {!failed && (
        <p className="text-pretty text-xs text-kumo-subtle">
          {catalogComplete
            ? `All ${(
                available.length +
                connections.filter((entry) => entry.accounts.length > 0).length
              ).toLocaleString()} Composio apps are searchable here. `
            : "Composio’s full catalog could not load, so only common apps are shown. "}
          {AGENT_NAME} discovers and runs their actions through one MCP connection.
        </p>
      )}
    </div>
  );
}

// --- Skills tab ---

function SkillsTab() {
  const [skills, setSkills] = useState<SkillItem[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftDescription, setDraftDescription] = useState("");
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/skills")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { skills?: SkillItem[] } | null) => setSkills(body?.skills ?? []))
      .catch(() => setSkills([]));
  }, []);

  function startEdit(skill: SkillItem) {
    setEditing(skill.name);
    setExpanded(skill.name);
    setDraftDescription(skill.description);
    setDraftMarkdown(skill.markdown);
  }

  function saveEdit(name: string) {
    if (draftDescription.trim().length === 0 || draftMarkdown.trim().length === 0) return;
    setSaving(true);
    void fetch("/api/skills", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: draftDescription, markdown: draftMarkdown }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { skill?: SkillItem } | null) => {
        if (body?.skill) {
          setSkills(
            (prev) => prev?.map((skill) => (skill.name === name ? body.skill! : skill)) ?? null,
          );
        }
        setEditing(null);
      })
      .finally(() => setSaving(false));
  }

  function deleteSkill(name: string) {
    setSkills((prev) => prev?.filter((skill) => skill.name !== name) ?? null);
    void fetch("/api/skills", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  if (skills === null) return <LoadingRow />;
  if (skills.length === 0) {
    return (
      <EmptyNote>
          No saved skills. Describe a repeatable workflow in chat and ask {AGENT_NAME} to save it
          as a skill.
      </EmptyNote>
    );
  }

  return (
    <ul className="flex flex-col">
      {skills.map((skill) => {
        const isExpanded = expanded === skill.name;
        const isEditing = editing === skill.name;
        return (
          <li key={skill.name} className="border-b border-kumo-hairline py-2 last:border-b-0">
            <div className="flex items-center gap-1">
              <ExpandCaret
                expanded={isExpanded}
                label={`${isExpanded ? "Collapse" : "Expand"} ${skill.name}`}
                onToggle={() => {
                  setExpanded(isExpanded ? null : skill.name);
                  if (editing === skill.name) setEditing(null);
                }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm">/{skill.name}</p>
                <p className="truncate text-xs text-kumo-subtle" title={skill.description}>
                  {skill.description}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={PencilSimpleIcon}
                aria-label={`Edit ${skill.name}`}
                title={`Edit ${skill.name}`}
                onClick={() => (isEditing ? setEditing(null) : startEdit(skill))}
              />
              <DeleteButton
                label={`Delete skill ${skill.name}`}
                onDelete={() => deleteSkill(skill.name)}
              />
            </div>
            {isExpanded && !isEditing && (
              <pre className="mt-2 max-h-64 overflow-y-auto rounded-md bg-kumo-recessed p-3 text-xs whitespace-pre-wrap text-kumo-subtle [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {skill.markdown}
              </pre>
            )}
            {isExpanded && isEditing && (
              <div className="mt-2 flex flex-col gap-2">
                <Input
                  size="sm"
                  value={draftDescription}
                  aria-label="Skill description"
                  placeholder={`When should ${AGENT_NAME} use this skill?`}
                  onChange={(event) => setDraftDescription(event.target.value)}
                />
                <InputArea
                  value={draftMarkdown}
                  aria-label="Skill instructions"
                  autoResize
                  minRows={6}
                  maxRows={14}
                  className="font-mono text-xs"
                  onChange={(event) => setDraftMarkdown(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={saving}
                    onClick={() => saveEdit(skill.name)}
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface FeatureFlags {
  memory: boolean;
  proactive: boolean;
  integrations: boolean;
  skills: boolean;
  /** Deployment ships the desktop feature; the tab doubles as key setup, so it
   * shows even before a key is configured. */
  computerAvailable: boolean;
  /** Same idea for payments: the tab is where the connection is made. */
  cardAvailable: boolean;
  /** And for iMessage: the tab is where pairing happens. */
  imessageAvailable: boolean;
  /** And for Slack: the tab is where reaction rules are written. */
  slackAvailable: boolean;
  /** And for the phone: the tab is where the number is provisioned. */
  phoneAvailable: boolean;
}

// Personal deployments have everything; builder deployments report what they
// shipped via /api/features so tabs for absent features never render.
const ALL_FEATURES_ON: FeatureFlags = {
  memory: true,
  proactive: true,
  integrations: true,
  skills: true,
  computerAvailable: true,
  cardAvailable: true,
  imessageAvailable: true,
  slackAvailable: true,
  phoneAvailable: true,
};

interface UpdateInfo {
  updateAvailable: boolean;
  currentVersion?: string;
  latestVersion?: string;
  updateUrl?: string;
}

export function ManagePanel({
  onOpenThread,
  sidebarOpen,
  onOpenSidebar,
  onCloseSidebar,
  onBack,
  onOpenCommandPalette,
}: {
  /** Jump to a thread (e.g. one a reminder delivered). */
  onOpenThread: (threadId: string) => void;
  /** Whether the shared off-canvas sidebar is open (matters below md). */
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onCloseSidebar: () => void;
  /** Return to the chat view; the sections sidebar swaps back to threads. */
  onBack: () => void;
  /** Open the app-wide navigation and command search. */
  onOpenCommandPalette: () => void;
}) {
  // A URL-named section is trusted even before /api/features answers; the
  // fallback effect below corrects it if the feature turns out to be absent.
  const [tab, setTab] = useState(() => tabFromLocation() ?? "reminders");
  const [features, setFeatures] = useState<FeatureFlags>(ALL_FEATURES_ON);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [reminders, setReminders] = useState<ReminderItem[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookItem[] | null>(null);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [delivery, setDelivery] = useState<DeliveryView | null>(null);
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/features")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: Partial<FeatureFlags> | null) => {
        if (body !== null) setFeatures({ ...ALL_FEATURES_ON, ...body });
      })
      .catch(() => undefined);
    // Builder-deployed agents carry a baked template stamp; ask the builder
    // whether a newer template exists. The personal app reports "no update".
    void fetch("/api/update-check")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: UpdateInfo | null) => setUpdate(body))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetch("/api/automations")
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          body: {
            reminders?: ReminderItem[];
            webhooks?: WebhookItem[];
            runs?: RunItem[];
            delivery?: DeliveryView;
          } | null,
        ) => {
          setReminders(body?.reminders ?? []);
          setWebhooks(body?.webhooks ?? []);
          setRuns(body?.runs ?? []);
          setDelivery(body?.delivery ?? null);
        },
      )
      .catch(() => {
        setReminders([]);
        setWebhooks([]);
      });
    void fetch("/api/memories")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { memories?: MemoryItem[] } | null) => setMemories(body?.memories ?? []))
      .catch(() => setMemories([]));
  }, []);

  function changeDelivery(target: DeliveryTarget) {
    setDelivery((prev) => (prev === null ? prev : { ...prev, target }));
    void fetch("/api/automations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delivery: target }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { delivery?: DeliveryView } | null) => {
        if (body?.delivery !== undefined) setDelivery(body.delivery);
      })
      .catch(() => undefined);
  }

  function cancelReminder(id: number) {
    setReminders((prev) => prev?.filter((reminder) => reminder.id !== id) ?? null);
    void fetch("/api/automations", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reminder", id }),
    });
  }

  function deleteWebhook(id: string) {
    setWebhooks((prev) => prev?.filter((hook) => hook.id !== id) ?? null);
    void fetch("/api/automations", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", id }),
    });
  }

  function forgetMemory(id: string) {
    setMemories((prev) => prev?.filter((memory) => memory.id !== id) ?? null);
    void fetch("/api/memories", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  function runsFor(kind: "reminder" | "webhook", automationId: string | number): RunItem[] {
    const id = String(automationId);
    return runs.filter((run) => run.kind === kind && run.automationId === id);
  }

  const sections: {
    value: string;
    label: string;
    icon: React.ElementType;
    count?: number;
  }[] = [
    { value: "appearance", label: "Appearance", icon: SunIcon },
    ...(features.proactive
      ? [
          { value: "reminders", label: "Reminders", icon: AlarmIcon, count: reminders?.length },
          { value: "webhooks", label: "Triggers", icon: LightningIcon, count: webhooks?.length },
        ]
      : []),
    ...(features.memory
      ? [{ value: "memory", label: "Memory", icon: BrainIcon, count: memories?.length }]
      : []),
    ...(features.integrations
      ? [{ value: "connections", label: "Connections", icon: PlugsIcon }]
      : []),
    ...(features.skills ? [{ value: "skills", label: "Skills", icon: MagicWandIcon }] : []),
    ...(features.computerAvailable
      ? [{ value: "computer", label: "Computer", icon: MonitorIcon }]
      : []),
    ...(features.cardAvailable ? [{ value: "card", label: "Card", icon: CreditCardIcon }] : []),
    ...(features.imessageAvailable
      ? [{ value: "imessage", label: "iMessage", icon: ChatCircleDotsIcon }]
      : []),
    ...(features.slackAvailable ? [{ value: "slack", label: "Slack", icon: HashIcon }] : []),
    ...(features.phoneAvailable ? [{ value: "phone", label: "Phone", icon: PhoneIcon }] : []),
  ];

  // If the active section's feature turns out to be absent, land on the first
  // section that exists instead of an empty pane.
  useEffect(() => {
    if (sections.length > 0 && !sections.some((entry) => entry.value === tab)) {
      setTab(sections[0].value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the derived list
  }, [features, tab]);

  /** Switch sections, recording the switch in the URL. */
  function selectTab(value: string) {
    setTab(value);
    const url = new URL(window.location.href);
    if (url.searchParams.get(TAB_PARAM) === value) return;
    url.searchParams.set(TAB_PARAM, value);
    window.history.pushState(null, "", url.pathname + url.search);
  }

  // Catch-all URL sync: clicks record `?tab=` themselves, but the section can
  // also change with no navigation (the fallback above, a bogus URL value).
  // replaceState so those corrections don't grow history; on first open this
  // also stamps the param onto a bare "/manage" entry.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get(TAB_PARAM) === tab) return;
    url.searchParams.set(TAB_PARAM, tab);
    window.history.replaceState(null, "", url.pathname + url.search);
  }, [tab]);

  // Back/forward across section switches while the panel is mounted. Entries
  // that name no section (from before the panel opened) keep the current one.
  useEffect(() => {
    function onPopState() {
      const value = tabFromLocation();
      if (value !== null) setTab(value);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const activeSection = sections.find((entry) => entry.value === tab);

  return (
    <>
      <aside
        className={cn(
          // Mirrors the thread sidebar exactly — same width, surface, and
          // off-canvas mobile behavior — so Manage swaps into the same slot.
          "fixed inset-y-0 start-0 z-40 flex w-64 shrink-0 -translate-x-full flex-col border-e border-kumo-hairline bg-kumo-elevated transition-transform duration-200 md:static md:translate-x-0",
          sidebarOpen && "translate-x-0",
        )}
      >
        <div className="flex items-center gap-1 px-3 py-2.5">
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={CaretLeftIcon}
            aria-label="Back to chat"
            title="Back to chat"
            onClick={onBack}
          />
          <span className="text-sm font-semibold">Manage</span>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={CommandIcon}
            className="ms-auto"
            aria-label="Open command palette"
            title="Open command palette (⌘/Ctrl+K)"
            onClick={onOpenCommandPalette}
          />
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Manage sections">
          <ul className="flex flex-col gap-0.5">
            {sections.map(({ value, label, icon: Icon, count }) => (
              <li key={value}>
                <button
                  type="button"
                  aria-current={tab === value ? "page" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-start text-sm hover:bg-kumo-tint",
                    tab === value && "bg-kumo-tint text-kumo-strong",
                  )}
                  onClick={() => {
                    selectTab(value);
                    onCloseSidebar();
                  }}
                >
                  <Icon className="size-4 shrink-0 text-kumo-subtle" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {count !== undefined && <span className="text-xs text-kumo-subtle">{count}</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <main className="relative h-dvh min-w-0 flex-1 overflow-y-auto">
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={SidebarSimpleIcon}
          className="absolute start-2 top-2 z-20 md:hidden"
          aria-label="Open manage sections"
          onClick={onOpenSidebar}
        />
        <div className="w-full max-w-3xl px-6 py-6">
          <header className="mb-5 ps-9 md:ps-0">
            <h1 className="text-lg font-semibold">{activeSection?.label ?? "Manage"}</h1>
          </header>

          {update?.updateAvailable === true && update.updateUrl !== undefined && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-kumo-hairline bg-kumo-tint px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">A newer version of this agent is available</p>
                <p className="mt-0.5 text-xs text-kumo-subtle">
                  Updating takes a few minutes and keeps your chats, memories, connections,
                  skills, and settings.
                  {update.currentVersion !== undefined && update.latestVersion !== undefined && (
                    <span className="ms-1 font-mono">
                      {update.currentVersion} &rarr; {update.latestVersion}
                    </span>
                  )}
                </p>
              </div>
              <a
                href={update.updateUrl}
                target="_blank"
                rel="noreferrer"
                className="flex shrink-0 items-center gap-1 text-sm font-medium text-kumo-interact hover:underline"
              >
                Update
                <ArrowSquareOutIcon className="size-3.5" />
              </a>
            </div>
          )}

          {(tab === "reminders" || tab === "webhooks") && delivery !== null && (
            <DeliveryPicker delivery={delivery} onChange={changeDelivery} />
          )}

          {tab === "reminders" &&
            (reminders === null ? (
              <LoadingRow />
            ) : reminders.length === 0 ? (
              <EmptyNote>
                No reminders. Try &ldquo;remind me to stretch at 6pm&rdquo; in chat.
              </EmptyNote>
            ) : (
              <ul className="flex flex-col">
                {reminders.map((reminder) => {
                  const history = runsFor("reminder", reminder.id);
                  const expanded = expandedRuns === `reminder:${reminder.id}`;
                  return (
                    <li
                      key={reminder.id}
                      className="border-b border-kumo-hairline py-2 last:border-b-0"
                    >
                      <div className="flex items-center gap-2">
                        <ExpandCaret
                          expanded={expanded}
                          label={`${expanded ? "Hide" : "Show"} run history`}
                          onToggle={() =>
                            setExpandedRuns(expanded ? null : `reminder:${reminder.id}`)
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm" title={reminder.prompt}>
                            {reminder.prompt}
                          </p>
                          <p className="mt-0.5 text-xs text-kumo-subtle">
                            Next: {formatWhen(reminder.nextFireAt)}
                            {reminder.cron !== null && ` · ${reminder.cron} (${reminder.timezone})`}
                            {history.length > 0 && ` · ran ${history.length}×`}
                          </p>
                        </div>
                        <Badge variant="secondary">
                          {reminder.cron === null ? "one-off" : "recurring"}
                        </Badge>
                        <DeleteButton
                          label={`Cancel reminder ${reminder.id}`}
                          onDelete={() => cancelReminder(reminder.id)}
                        />
                      </div>
                      {expanded && <RunHistory runs={history} onOpenThread={onOpenThread} />}
                    </li>
                  );
                })}
              </ul>
            ))}

          {tab === "webhooks" &&
            (webhooks === null ? (
              <LoadingRow />
            ) : webhooks.length === 0 ? (
              <EmptyNote>
                No event triggers. Ask {AGENT_NAME} to “create a webhook for deploy alerts”.
              </EmptyNote>
            ) : (
              <ul className="flex flex-col">
                {webhooks.map((hook) => {
                  const history = runsFor("webhook", hook.id);
                  const expanded = expandedRuns === `webhook:${hook.id}`;
                  return (
                    <li
                      key={hook.id}
                      className="border-b border-kumo-hairline py-2 last:border-b-0"
                    >
                      <div className="flex items-center gap-2">
                        <ExpandCaret
                          expanded={expanded}
                          label={`${expanded ? "Hide" : "Show"} run history`}
                          onToggle={() => setExpandedRuns(expanded ? null : `webhook:${hook.id}`)}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{hook.name}</p>
                          <p
                            className="mt-0.5 truncate text-xs text-kumo-subtle"
                            title={hook.prompt}
                          >
                            {hook.prompt}
                          </p>
                          <p className="mt-0.5 text-xs text-kumo-subtle">
                            Fired {hook.fireCount} {hook.fireCount === 1 ? "time" : "times"} ·
                            last {formatWhen(hook.lastFiredAt)}
                          </p>
                        </div>
                        <CopyUrlButton url={hook.url} />
                        <DeleteButton
                          label={`Delete trigger ${hook.name}`}
                          onDelete={() => deleteWebhook(hook.id)}
                        />
                      </div>
                      {expanded && <RunHistory runs={history} onOpenThread={onOpenThread} />}
                    </li>
                  );
                })}
              </ul>
            ))}

          {tab === "memory" &&
            (memories === null ? (
              <LoadingRow />
            ) : memories.length === 0 ? (
              <EmptyNote>No saved memories yet.</EmptyNote>
            ) : (
              <ul className="flex flex-col">
                {memories.map((memory) => (
                  <li
                    key={memory.id}
                    className="flex items-center gap-3 border-b border-kumo-hairline py-2.5 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm break-words">{memory.content}</p>
                      <p className="mt-0.5 text-xs text-kumo-subtle">
                        Updated {formatWhen(memory.updatedAt)}
                      </p>
                    </div>
                    {memory.permanent && <Badge variant="secondary">permanent</Badge>}
                    <DeleteButton label="Forget memory" onDelete={() => forgetMemory(memory.id)} />
                  </li>
                ))}
              </ul>
            ))}

          {tab === "connections" && <ConnectionsTab />}

          {tab === "skills" && <SkillsTab />}

          {tab === "appearance" && <AppearancePanel />}

          {tab === "computer" && (
            <div className="flex flex-col gap-5">
              <LocalComputerPanel />
              <section>
                <h2 className="mb-3 text-balance text-sm font-semibold">Cloud desktop</h2>
                <ComputerViewer />
              </section>
            </div>
          )}

          {tab === "card" && <CardPanel />}

          {tab === "imessage" && <IMessagePanel />}

          {tab === "slack" && <SlackPanel />}

          {tab === "phone" && <PhoneComingSoon />}
        </div>
      </main>
    </>
  );
}
