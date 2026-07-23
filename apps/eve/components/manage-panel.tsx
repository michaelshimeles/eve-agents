"use client";

import { Badge, DropdownMenu, Tabs, TextArea, TextField } from "frosted-ui";
import { Button, Loader } from "@/components/ui/compat";
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
  PencilSimpleIcon,
  PlugsIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

// Management surface for everything Eve does or knows on her own: scheduled
// reminders, event-trigger webhooks, long-term memory, connected apps, and
// saved skills. Reminders/webhooks/memory stay read + delete (creation is
// conversational); connections can be added/removed here because that's an
// OAuth flow, and skills are editable since they're plain markdown.
// Rendered by the /manage page.

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

interface MemoryItem {
  id: string;
  content: string;
  permanent: boolean;
  updatedAt: string | null;
}

interface ConnectionItem {
  toolkit: string;
  accounts: {
    id: string;
    status: string;
    alias: string | null;
    label: string | null;
  }[];
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
  return <p className="py-8 text-center text-sm text-gray-11">{children}</p>;
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
    return <p className="pb-2 ps-6 text-xs text-gray-11">No runs recorded yet.</p>;
  }
  return (
    <ul className="mb-2 flex flex-col gap-1 ps-6">
      {runs.slice(0, 5).map((run) => (
        <li key={run.id} className="flex items-center gap-2 text-xs">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              run.status === "ok" ? "bg-success-11" : "bg-danger-9",
            )}
            aria-hidden
          />
          <span className="text-gray-11">{formatWhen(run.firedAt)}</span>
          {run.status === "error" && (
            <span className="truncate text-danger-11" title={run.error ?? undefined}>
              {run.error ?? "failed"}
            </span>
          )}
          {run.threadId !== null && (
            <button
              type="button"
              className="flex items-center gap-1 text-accent-11 hover:underline"
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
    return <PlugsIcon className="size-4 shrink-0 text-gray-11" aria-hidden />;
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
  const [available, setAvailable] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [pendingToolkit, setPendingToolkit] = useState<string | null>(null);

  function load() {
    void fetch("/api/connections")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { connections?: ConnectionItem[]; checked?: string[] } | null) => {
        if (body === null) {
          setFailed(true);
          setConnections([]);
          return;
        }
        const connected = new Set((body.connections ?? []).map((entry) => entry.toolkit));
        setConnections(body.connections ?? []);
        setAvailable((body.checked ?? []).filter((toolkit) => !connected.has(toolkit)));
      })
      .catch(() => {
        setFailed(true);
        setConnections([]);
      });
  }

  useEffect(load, []);

  function connect(toolkit: string) {
    setPendingToolkit(toolkit);
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
        alert(error instanceof Error ? error.message : "Connect failed");
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
        <EmptyNote>No connected apps yet. Connect one below or ask Eve in chat.</EmptyNote>
      )}
      {connections.filter((entry) => entry.accounts.length > 0).length > 0 && (
        <ul className="flex flex-col">
          {connections
            .filter((entry) => entry.accounts.length > 0)
            .map((entry) => (
              <li
                key={entry.toolkit}
                className="border-b border-gray-a4 py-2.5 last:border-b-0"
              >
                <div className="flex items-center gap-2">
                  <ToolkitLogo toolkit={entry.toolkit} />
                  <span className="text-sm font-medium capitalize">{entry.toolkit}</span>
                </div>
                <ul className="mt-1 flex flex-col gap-1">
                  {entry.accounts.map((account) => (
                    <li key={account.id} className="flex items-center gap-2 ps-6">
                      <span className="min-w-0 flex-1 truncate text-xs text-gray-11">
                        {account.alias ?? account.label ?? account.id}
                      </span>
                      <Badge variant="soft" color={account.status === "active" ? "green" : "gray"}>
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
        <div className="pt-1">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Button variant="secondary" size="sm" disabled={pendingToolkit !== null}>
                <PlusIcon className="size-3.5" aria-hidden />
                {pendingToolkit !== null ? "Opening…" : "Connect an app"}
                <CaretDownIcon className="size-3 text-gray-11" aria-hidden />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start">
              {available.map((toolkit) => (
                <DropdownMenu.Item key={toolkit} onClick={() => connect(toolkit)}>
                  <span className="flex items-center gap-2 capitalize">
                    <ToolkitLogo toolkit={toolkit} />
                    {toolkit}
                  </span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      )}
      {!failed && (
        <p className="text-xs text-gray-11">
          Other apps can be connected by asking Eve in chat — this list covers the common ones.
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
        No saved skills. Describe a repeatable workflow in chat and ask Eve to save it as a skill.
      </EmptyNote>
    );
  }

  return (
    <ul className="flex flex-col">
      {skills.map((skill) => {
        const isExpanded = expanded === skill.name;
        const isEditing = editing === skill.name;
        return (
          <li key={skill.name} className="border-b border-gray-a4 py-2 last:border-b-0">
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
                <p className="truncate text-xs text-gray-11" title={skill.description}>
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
              <pre className="mt-2 max-h-64 overflow-y-auto rounded-md bg-gray-a2 p-3 text-xs whitespace-pre-wrap text-gray-11 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {skill.markdown}
              </pre>
            )}
            {isExpanded && isEditing && (
              <div className="mt-2 flex flex-col gap-2">
                <TextField.Input
                  size="2"
                  value={draftDescription}
                  aria-label="Skill description"
                  placeholder="When should Eve use this skill?"
                  onChange={(event) => setDraftDescription(event.target.value)}
                />
                <TextArea
                  value={draftMarkdown}
                  aria-label="Skill instructions"
                  className="[&>textarea]:field-sizing-content [&>textarea]:min-h-32 [&>textarea]:max-h-80 [&>textarea]:font-mono [&>textarea]:text-xs"
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
}

// Personal deployments have everything; builder deployments report what they
// shipped via /api/features so tabs for absent features never render.
const ALL_FEATURES_ON: FeatureFlags = {
  memory: true,
  proactive: true,
  integrations: true,
  skills: true,
};

export function ManagePanel({
  onOpenThread,
}: {
  /** Jump to a thread (e.g. one a reminder delivered). */
  onOpenThread: (threadId: string) => void;
}) {
  const [tab, setTab] = useState("reminders");
  const [features, setFeatures] = useState<FeatureFlags>(ALL_FEATURES_ON);
  const [reminders, setReminders] = useState<ReminderItem[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookItem[] | null>(null);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/features")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: Partial<FeatureFlags> | null) => {
        if (body !== null) setFeatures({ ...ALL_FEATURES_ON, ...body });
      })
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
          } | null,
        ) => {
          setReminders(body?.reminders ?? []);
          setWebhooks(body?.webhooks ?? []);
          setRuns(body?.runs ?? []);
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

  const visibleTabs = [
    ...(features.proactive
      ? [
          { value: "reminders", label: `Reminders${reminders ? ` (${reminders.length})` : ""}` },
          { value: "webhooks", label: `Triggers${webhooks ? ` (${webhooks.length})` : ""}` },
        ]
      : []),
    ...(features.memory
      ? [{ value: "memory", label: `Memory${memories ? ` (${memories.length})` : ""}` }]
      : []),
    ...(features.integrations ? [{ value: "connections", label: "Connections" }] : []),
    ...(features.skills ? [{ value: "skills", label: "Skills" }] : []),
  ];

  // If the active tab's feature turns out to be absent, land on the first
  // tab that exists instead of an empty pane.
  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.some((entry) => entry.value === tab)) {
      setTab(visibleTabs[0].value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the derived list
  }, [features, tab]);

  return (
    <div>
      <Tabs.Root value={tab} onValueChange={(value) => setTab(value as string)}>
        {/* Hug the tab labels instead of stretching across the page column. */}
        <Tabs.List size="1" className="w-fit max-w-full">
          {visibleTabs.map((entry) => (
            <Tabs.Trigger key={entry.value} value={entry.value}>
              {entry.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>

      <div className="mt-3 min-h-40">
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
                    className="border-b border-gray-a4 py-2 last:border-b-0"
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
                        <p className="mt-0.5 text-xs text-gray-11">
                          Next: {formatWhen(reminder.nextFireAt)}
                          {reminder.cron !== null && ` · ${reminder.cron} (${reminder.timezone})`}
                          {history.length > 0 && ` · ran ${history.length}×`}
                        </p>
                      </div>
                      <Badge variant="soft" color="gray">
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
              No event triggers. Ask Eve to &ldquo;create a webhook for deploy alerts&rdquo;.
            </EmptyNote>
          ) : (
            <ul className="flex flex-col">
              {webhooks.map((hook) => {
                const history = runsFor("webhook", hook.id);
                const expanded = expandedRuns === `webhook:${hook.id}`;
                return (
                  <li key={hook.id} className="border-b border-gray-a4 py-2 last:border-b-0">
                    <div className="flex items-center gap-2">
                      <ExpandCaret
                        expanded={expanded}
                        label={`${expanded ? "Hide" : "Show"} run history`}
                        onToggle={() => setExpandedRuns(expanded ? null : `webhook:${hook.id}`)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{hook.name}</p>
                        <p className="mt-0.5 truncate text-xs text-gray-11" title={hook.prompt}>
                          {hook.prompt}
                        </p>
                        <p className="mt-0.5 text-xs text-gray-11">
                          Fired {hook.fireCount} {hook.fireCount === 1 ? "time" : "times"} · last{" "}
                          {formatWhen(hook.lastFiredAt)}
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
                  className="flex items-center gap-3 border-b border-gray-a4 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm break-words">{memory.content}</p>
                    <p className="mt-0.5 text-xs text-gray-11">
                      Updated {formatWhen(memory.updatedAt)}
                    </p>
                  </div>
                  {memory.permanent && <Badge variant="soft" color="gray">permanent</Badge>}
                  <DeleteButton label="Forget memory" onDelete={() => forgetMemory(memory.id)} />
                </li>
              ))}
            </ul>
          ))}

        {tab === "connections" && <ConnectionsTab />}

        {tab === "skills" && <SkillsTab />}
      </div>
    </div>
  );
}
