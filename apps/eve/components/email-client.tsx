"use client";

import { Badge, Button, Dialog, Input, InputArea, Loader } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  ArrowUUpLeftIcon,
  CaretLeftIcon,
  CheckIcon,
  CopyIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  GlobeSimpleIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
  PaperclipIcon,
  SidebarSimpleIcon,
  TrashIcon,
  TrayIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AGENT_NAME } from "@/lib/identity";
import type {
  EmailAccount,
  EmailAddress,
  EmailFolder,
  EmailListResponse,
  EmailMessageView,
  EmailThreadSummary,
  EmailThreadView,
} from "@/lib/email-api";
import { cn } from "@/lib/utils";

// The agent's own email account, as an email client: folder rail, thread list,
// reading pane, compose and reply. Everything here goes through /api/email/**,
// which reads and writes the same AgentMail inbox the agent's email tools use —
// so mail Ruth sends shows up in Sent, and a thread she marks read is read here
// too. Rendered by the /email page.

const FOLDERS: { value: EmailFolder; label: string; icon: React.ElementType }[] = [
  { value: "inbox", label: "Inbox", icon: TrayIcon },
  { value: "unread", label: "Unread", icon: EnvelopeIcon },
  { value: "sent", label: "Sent", icon: PaperPlaneTiltIcon },
  { value: "all", label: "All mail", icon: EnvelopeOpenIcon },
  { value: "trash", label: "Trash", icon: TrashIcon },
];

interface ListState {
  account: EmailAccount | null;
  threads: EmailThreadSummary[];
  unreadCount: number;
}

function displayName(address: EmailAddress): string {
  return address.name ?? address.address;
}

function formatListDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatFullDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={copied ? CheckIcon : CopyIcon}
      aria-label="Copy email address"
      title="Copy email address"
      onClick={() => {
        void navigator.clipboard.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}

/**
 * An email's HTML body, isolated in an iframe. Inbound mail is untrusted, so the
 * markup is sanitized server-side and the frame gets no script permission; it is
 * same-origin only so we can size it to its content, and popups are allowed so
 * links still open in a new tab.
 */
function HtmlBody({ html }: { html: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(160);

  const doc = useMemo(
    () =>
      [
        "<!doctype html><html><head>",
        // No network, full stop: the sanitizer strips trackers it recognizes,
        // and this blocks whatever it might miss (CSS url(), fonts, media).
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">",
        '<base target="_blank">',
        "<style>",
        "  :root { color-scheme: light }",
        "  html, body { margin: 0; padding: 0; overflow: hidden }",
        "  body { background: #fff; color: #111;",
        "         font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; word-break: break-word }",
        "  img, table { max-width: 100% !important; height: auto }",
        "  a { color: #0b62d1 }",
        "</style></head><body>",
        // Measured instead of the body, whose height is pinned to the frame.
        `<div id="content">${html}</div>`,
        "</body></html>",
      ].join(""),
    [html],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  // Grow the frame to fit. One measure on load is too early for mail that
  // reflows as tables and fonts settle, so watch the wrapper and follow it.
  function watchContent() {
    observerRef.current?.disconnect();
    const content = frameRef.current?.contentDocument?.getElementById("content");
    if (content === null || content === undefined) return;
    const measure = () =>
      setHeight(Math.min(Math.max(Math.ceil(content.getBoundingClientRect().height), 60), 2400));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observerRef.current = observer;
  }

  return (
    <iframe
      ref={frameRef}
      title="Email content"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      onLoad={watchContent}
      style={{ height }}
      className="w-full overflow-hidden rounded-lg bg-white ring ring-kumo-hairline"
    />
  );
}

function MessageCard({
  message,
  expandedByDefault,
}: {
  message: EmailMessageView;
  expandedByDefault: boolean;
}) {
  const [expanded, setExpanded] = useState(expandedByDefault);
  const [asText, setAsText] = useState(false);
  const showHtml = message.html !== null && !asText;

  return (
    <article className="border-b border-kumo-hairline py-4 last:border-b-0">
      <button
        type="button"
        className="flex w-full items-start gap-3 text-start"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
            message.direction === "sent"
              ? "bg-kumo-brand/15 text-kumo-brand"
              : "bg-kumo-tint text-kumo-subtle",
          )}
          aria-hidden
        >
          {displayName(message.from).slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{displayName(message.from)}</span>
            {message.direction === "sent" && <Badge variant="secondary">sent</Badge>}
            <span className="ms-auto shrink-0 text-xs text-kumo-subtle">
              {formatFullDate(message.timestamp)}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-kumo-subtle">
            to {message.to.map(displayName).join(", ") || "(no recipients)"}
            {message.cc.length > 0 && ` · cc ${message.cc.map(displayName).join(", ")}`}
          </span>
          {!expanded && (
            <span className="mt-1 block truncate text-xs text-kumo-subtle">
              {message.text.replaceAll("\n", " ").trim()}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 ps-10">
          {showHtml && message.html !== null ? (
            <HtmlBody html={message.html} />
          ) : (
            <pre className="text-sm whitespace-pre-wrap text-kumo-default">
              {message.text.length > 0 ? message.text : "(empty message)"}
            </pre>
          )}
          {message.html !== null && (
            <button
              type="button"
              className="mt-2 text-xs text-kumo-interact hover:underline"
              onClick={() => setAsText((prev) => !prev)}
            >
              {asText ? "Show formatted" : "Show plain text"}
            </button>
          )}
          {message.attachments.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((attachment) => (
                <li key={attachment.attachmentId}>
                  <a
                    href={`/api/email/attachments/${encodeURIComponent(message.messageId)}/${encodeURIComponent(attachment.attachmentId)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 rounded-lg border border-kumo-hairline px-2.5 py-1.5 text-xs hover:bg-kumo-tint"
                  >
                    <PaperclipIcon className="size-3.5 text-kumo-subtle" aria-hidden />
                    <span className="max-w-40 truncate">{attachment.filename}</span>
                    <span className="text-kumo-subtle">{formatBytes(attachment.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

interface KeyStateView {
  source: "env" | "app" | "none";
  hint: string | null;
  canStore: boolean;
}

/**
 * Paste-an-API-key form, shared by the first-run setup screen and the key
 * dialog. The key is validated against AgentMail server-side before it is
 * stored, so a typo fails loudly here instead of breaking the mailbox.
 */
function ApiKeyForm({
  onSaved,
  autoFocus = false,
}: {
  onSaved: (emailAddress: string) => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setBusy(true);
    setError(null);
    void fetch("/api/email/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: draft }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          const fallback = await response.text().catch(() => "");
          throw new Error(body?.error ?? (fallback.length > 0 ? fallback : "Save failed"));
        }
        return response.json() as Promise<{ emailAddress: string }>;
      })
      .then((body) => {
        setDraft("");
        onSaved(body.emailAddress);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Save failed"))
      .finally(() => setBusy(false));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          size="sm"
          type="password"
          value={draft}
          aria-label="AgentMail API key"
          placeholder="am_…"
          autoComplete="off"
          autoFocus={autoFocus}
          className="flex-1 font-mono"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim().length > 0 && !busy) save();
          }}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={draft.trim().length === 0 || busy}
          onClick={save}
        >
          {busy ? "Checking…" : "Save"}
        </Button>
      </div>
      {error !== null && <p className="text-xs text-kumo-danger">{error}</p>}
    </div>
  );
}

/** The AgentMail credential: which source is active, replace it, remove it. */
function ApiKeyDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<KeyStateView | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  });

  const load = useCallback(() => {
    void fetch("/api/email/key")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: KeyStateView | null) => setState(body))
      .catch(() => setState(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    setState(null);
    setConfirmingRemove(false);
    load();
  }, [open, load]);

  function remove() {
    void fetch("/api/email/key", { method: "DELETE" }).then(() => {
      setConfirmingRemove(false);
      load();
      onChangedRef.current();
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6">
        <Dialog.Title>AgentMail API key</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
          The credential behind {AGENT_NAME}&rsquo;s inbox.
        </Dialog.Description>

        {state === null ? (
          <div className="flex justify-center py-8">
            <Loader size={18} />
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm">
              {state.source === "env" && (
                <>
                  Using the key from the deployment environment{" "}
                  {state.hint !== null && <span className="font-mono text-xs">({state.hint})</span>}
                  . It always wins over a key stored in the app, so managing it happens wherever
                  the environment is configured.
                </>
              )}
              {state.source === "app" && (
                <>
                  Using a key stored in the app{" "}
                  {state.hint !== null && <span className="font-mono text-xs">({state.hint})</span>}
                  . Paste a new one to replace it.
                </>
              )}
              {state.source === "none" && <>No key is configured yet. Paste one to set up email.</>}
            </p>

            {state.source !== "env" &&
              (state.canStore ? (
                <ApiKeyForm
                  onSaved={() => {
                    load();
                    onChangedRef.current();
                  }}
                />
              ) : (
                <p className="text-xs text-kumo-subtle">
                  Storing a key in the app needs a database (DATABASE_URL). Without one, set
                  AGENTMAIL_API_KEY in the deployment environment.
                </p>
              ))}

            {state.source === "app" && (
              <div className="flex justify-end">
                {confirmingRemove ? (
                  <Button variant="destructive" size="sm" onClick={remove}>
                    Confirm remove
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(true)}>
                    Remove key
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

interface DomainRecordView {
  type: string;
  name: string;
  value: string;
  status: "MISSING" | "INVALID" | "VALID";
  priority?: number;
}

interface DomainStateView {
  connected: boolean;
  domain?: string;
  status?: "NOT_STARTED" | "PENDING" | "INVALID" | "FAILED" | "VERIFYING" | "VERIFIED";
  records?: DomainRecordView[];
  active?: boolean;
  emailAddress: string;
}

const DOMAIN_STATUS_BADGE: Record<
  NonNullable<DomainStateView["status"]>,
  { variant: "secondary" | "warning" | "error" | "info" | "success"; label: string }
> = {
  NOT_STARTED: { variant: "secondary", label: "not started" },
  PENDING: { variant: "warning", label: "waiting for DNS records" },
  INVALID: { variant: "error", label: "records misconfigured" },
  FAILED: { variant: "error", label: "verification failed" },
  VERIFYING: { variant: "info", label: "verifying" },
  VERIFIED: { variant: "success", label: "verified" },
};

function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={copied ? CheckIcon : CopyIcon}
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}

/**
 * Connect the agent's address to a custom domain: register it, hand over the
 * DNS records to add at the registrar, watch verification, disconnect. Same
 * workflow the agent's own domain tools drive from chat.
 */
function DomainDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The connected domain (and possibly the address) changed; refresh. */
  onChanged: () => void;
}) {
  const [state, setState] = useState<DomainStateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // The parent passes an inline callback; going through a ref keeps `load`
  // stable so the open-effect doesn't refire on every parent render.
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  });

  const load = useCallback(() => {
    setError(null);
    void fetch("/api/email/domain")
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${response.status})`);
        }
        return response.json() as Promise<DomainStateView>;
      })
      .then((next) => {
        setState(next);
        // "Check now" is what completes the address switch when verification
        // just finished, so the page header has to hear about it too.
        onChangedRef.current();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not load domain status");
        setState({ connected: false, emailAddress: "" });
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    setState(null);
    setDraft("");
    setConfirmingRemove(false);
    load();
  }, [open, load]);

  function connect() {
    setBusy(true);
    setError(null);
    void fetch("/api/email/domain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: draft }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Connect failed");
        }
        return response.json() as Promise<DomainStateView>;
      })
      .then((next) => {
        setState(next);
        onChanged();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Connect failed"),
      )
      .finally(() => setBusy(false));
  }

  function disconnect() {
    setBusy(true);
    setError(null);
    void fetch("/api/email/domain", { method: "DELETE" })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.text()) || "Disconnect failed");
        return response.json() as Promise<DomainStateView>;
      })
      .then((next) => {
        setState(next);
        setConfirmingRemove(false);
        onChanged();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Disconnect failed"),
      )
      .finally(() => setBusy(false));
  }

  const badge = state?.status !== undefined ? DOMAIN_STATUS_BADGE[state.status] : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="xl" className="p-6">
        <Dialog.Title>Custom domain</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
          Put {AGENT_NAME}&rsquo;s address on a domain you own instead of agentmail.to.
        </Dialog.Description>

        {state === null ? (
          <div className="flex justify-center py-10">
            <Loader size={18} />
          </div>
        ) : !state.connected ? (
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex gap-2">
              <Input
                size="sm"
                value={draft}
                aria-label="Domain"
                placeholder="example.com"
                className="flex-1"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && draft.trim().length > 3 && !busy) connect();
                }}
              />
              <Button
                variant="primary"
                size="sm"
                disabled={draft.trim().length < 4 || busy}
                onClick={connect}
              >
                {busy ? "Connecting…" : "Connect"}
              </Button>
            </div>
            <p className="text-xs text-kumo-subtle">
              You&rsquo;ll get DNS records to add where the domain is hosted. Once they verify,{" "}
              {AGENT_NAME}&rsquo;s address moves to the domain automatically. Custom domains
              require a paid AgentMail plan. You can also do this by just asking {AGENT_NAME} in
              chat.
            </p>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm">{state.domain}</span>
              {badge !== null && <Badge variant={badge.variant}>{badge.label}</Badge>}
              {state.active === true && <Badge variant="success">address live</Badge>}
              <span className="ms-auto flex items-center gap-1">
                <Button variant="secondary" size="sm" disabled={busy} onClick={load}>
                  Check now
                </Button>
                {confirmingRemove ? (
                  <Button variant="destructive" size="sm" disabled={busy} onClick={disconnect}>
                    Confirm disconnect
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingRemove(true)}
                  >
                    Disconnect
                  </Button>
                )}
              </span>
            </div>

            <p className="text-xs text-kumo-subtle">
              {state.status === "VERIFIED"
                ? `Verified. ${AGENT_NAME}'s address is ${state.emailAddress}.`
                : `Add these records at your DNS provider, then check back - verification usually takes minutes after the records propagate, at most 48 hours. The address switches automatically once verified.`}
            </p>

            {(state.records ?? []).length > 0 && (
              <ul className="flex flex-col overflow-hidden rounded-lg border border-kumo-hairline">
                {(state.records ?? []).map((record, index) => {
                  const value =
                    record.priority !== undefined
                      ? `${record.priority} ${record.value}`
                      : record.value;
                  return (
                    <li
                      key={`${record.type}-${record.name}-${index}`}
                      className="flex items-center gap-2 border-b border-kumo-hairline bg-kumo-base px-3 py-2 last:border-b-0"
                    >
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          record.status === "VALID"
                            ? "bg-kumo-success"
                            : record.status === "INVALID"
                              ? "bg-kumo-danger"
                              : "bg-kumo-warning",
                        )}
                        title={record.status.toLowerCase()}
                        aria-label={`Record ${record.status.toLowerCase()}`}
                      />
                      <span className="w-12 shrink-0 font-mono text-xs text-kumo-subtle">
                        {record.type}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs" title={record.name}>
                          {record.name}
                        </span>
                        <span
                          className="block truncate font-mono text-xs text-kumo-subtle"
                          title={value}
                        >
                          {value}
                        </span>
                      </span>
                      <CopyValueButton value={record.name} label={`Copy ${record.type} name`} />
                      <CopyValueButton value={value} label={`Copy ${record.type} value`} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {error !== null && <p className="mt-3 text-xs text-kumo-danger">{error}</p>}
        <div className="mt-5 flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

function ComposeDialog({
  open,
  onOpenChange,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per draft, kept across retries: resubmitting after an ambiguous
  // failure makes AgentMail return the first result, not send a second copy.
  const sendIdRef = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    setTo("");
    setCc("");
    setSubject("");
    setText("");
    setError(null);
    sendIdRef.current = crypto.randomUUID();
  }, [open]);

  function send() {
    setSending(true);
    setError(null);
    void fetch("/api/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, cc, subject, text, clientSendId: sendIdRef.current }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.text()) || "Send failed");
        onOpenChange(false);
        onSent();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Send failed"))
      .finally(() => setSending(false));
  }

  const ready = to.includes("@") && subject.trim().length > 0 && text.trim().length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6">
        <Dialog.Title>New email</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
          Sent from {AGENT_NAME}&rsquo;s own address.
        </Dialog.Description>
        <div className="mt-4 flex flex-col gap-2">
          <Input
            size="sm"
            value={to}
            aria-label="To"
            placeholder="To (comma-separated)"
            onChange={(event) => setTo(event.target.value)}
          />
          <Input
            size="sm"
            value={cc}
            aria-label="Cc"
            placeholder="Cc (optional)"
            onChange={(event) => setCc(event.target.value)}
          />
          <Input
            size="sm"
            value={subject}
            aria-label="Subject"
            placeholder="Subject"
            onChange={(event) => setSubject(event.target.value)}
          />
          <InputArea
            value={text}
            aria-label="Message"
            placeholder="Write your message…"
            autoResize
            minRows={7}
            maxRows={16}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        {error !== null && <p className="mt-2 text-xs text-kumo-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!ready || sending} onClick={send}>
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

function ReplyBox({
  thread,
  onSent,
}: {
  thread: EmailThreadView;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [replyAll, setReplyAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per draft, kept across retries and replaced after a send lands, so
  // resubmitting a failed reply can never deliver it twice.
  const sendIdRef = useRef(crypto.randomUUID());

  // A different conversation gets a blank composer, not the last one's draft.
  useEffect(() => {
    setText("");
    setError(null);
    sendIdRef.current = crypto.randomUUID();
  }, [thread.threadId]);

  function send() {
    setSending(true);
    setError(null);
    void fetch("/api/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyToMessageId: thread.lastMessageId,
        replyAll,
        text,
        clientSendId: sendIdRef.current,
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.text()) || "Reply failed");
        setText("");
        sendIdRef.current = crypto.randomUUID();
        onSent();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Reply failed"))
      .finally(() => setSending(false));
  }

  return (
    <div className="border-t border-kumo-hairline bg-kumo-elevated px-3 py-3 md:px-5">
      <div className="mx-auto w-full max-w-3xl">
        <InputArea
          value={text}
          aria-label="Reply"
          placeholder="Write a reply…"
          autoResize
          minRows={2}
          maxRows={10}
          onChange={(event) => setText(event.target.value)}
        />
        {error !== null && <p className="mt-1.5 text-xs text-kumo-danger">{error}</p>}
        <div className="mt-2 flex items-center justify-between gap-3">
          <label className="flex items-center gap-1.5 text-xs text-kumo-subtle">
            <input
              type="checkbox"
              checked={replyAll}
              className="accent-kumo-brand"
              onChange={(event) => setReplyAll(event.target.checked)}
            />
            Reply to all
          </label>
          <Button
            variant="primary"
            size="sm"
            disabled={text.trim().length === 0 || sending}
            onClick={send}
          >
            {sending ? "Sending…" : "Send reply"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function EmailClient({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [folder, setFolder] = useState<EmailFolder>("inbox");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [list, setList] = useState<ListState | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<EmailThreadView | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  // Bumped to re-read the open conversation after a reply lands in it.
  const [threadRevision, setThreadRevision] = useState(0);
  const [composeOpen, setComposeOpen] = useState(false);
  const [domainOpen, setDomainOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Debounced so typing doesn't fire a search per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const loadList = useCallback(
    (options: { silent?: boolean } = {}) => {
      if (options.silent !== true) setList(null);
      setRefreshing(true);
      const params = new URLSearchParams({ folder });
      if (query.length > 0) params.set("q", query);
      void fetch(`/api/email?${params.toString()}`)
        .then(async (response) => {
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? `Request failed (${response.status})`);
          }
          return response.json() as Promise<EmailListResponse>;
        })
        .then((body) => {
          setConfigured(body.configured);
          setListError(null);
          setList({
            account: body.account ?? null,
            threads: body.threads,
            unreadCount: body.unreadCount,
          });
        })
        .catch((error: unknown) => {
          setConfigured(true);
          setListError(error instanceof Error ? error.message : "Could not load mail");
          setList({ account: null, threads: [], unreadCount: 0 });
        })
        .finally(() => setRefreshing(false));
    },
    [folder, query],
  );

  useEffect(loadList, [loadList]);

  // Keep the mailbox current the way the thread sidebar does: a slow poll plus
  // a refresh whenever the window regains focus.
  useEffect(() => {
    function refresh() {
      loadList({ silent: true });
    }
    const timer = setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [loadList]);

  useEffect(() => {
    if (selectedId === null) {
      setThread(null);
      return;
    }
    setThread(null);
    setThreadError(null);
    void fetch(`/api/email/threads/${encodeURIComponent(selectedId)}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${response.status})`);
        }
        return response.json() as Promise<{ thread: EmailThreadView }>;
      })
      .then((body) => {
        setThread(body.thread);
        // Opening a thread read it, so drop the dot without a full reload.
        setList((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                unreadCount: Math.max(
                  0,
                  prev.unreadCount -
                    (prev.threads.find((item) => item.threadId === selectedId)?.unread ? 1 : 0),
                ),
                threads: prev.threads.map((item) =>
                  item.threadId === selectedId ? { ...item, unread: false } : item,
                ),
              },
        );
      })
      .catch((error: unknown) =>
        setThreadError(error instanceof Error ? error.message : "Could not load conversation"),
      );
  }, [selectedId, threadRevision]);

  function setLabels(threadId: string, changes: { add?: string[]; remove?: string[] }) {
    void fetch(`/api/email/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    }).then(() => loadList({ silent: true }));
  }

  function trashThread(threadId: string) {
    setSelectedId(null);
    setList((prev) =>
      prev === null
        ? prev
        : { ...prev, threads: prev.threads.filter((item) => item.threadId !== threadId) },
    );
    setLabels(threadId, { add: ["trash"] });
  }

  function markUnread(threadId: string) {
    setSelectedId(null);
    setLabels(threadId, { add: ["unread"] });
  }

  const account = list?.account ?? null;

  if (configured === false) {
    return (
      <main className="relative h-dvh min-w-0 flex-1 overflow-y-auto">
        <MobileSidebarButton onOpenSidebar={onOpenSidebar} />
        <div className="mx-auto w-full max-w-xl px-6 py-16">
          <div className="text-center">
            <EnvelopeIcon className="mx-auto size-8 text-kumo-subtle" aria-hidden />
            {/* One template string: Turbopack drops the space between an
                expression and following text when the expression opens the
                element, rendering "Ruthdoesn't". */}
            <h1 className="mt-3 text-lg font-semibold">
              {`${AGENT_NAME} doesn’t have an inbox yet`}
            </h1>
            <p className="mt-2 text-sm text-kumo-subtle">
              Paste an AgentMail API key from{" "}
              <a
                href="https://console.agentmail.to"
                target="_blank"
                rel="noreferrer"
                className="text-kumo-interact hover:underline"
              >
                console.agentmail.to
              </a>{" "}
              and {AGENT_NAME} provisions her own address on the spot. She can then read, search,
              send, and reply to her own mail, and this page shows everything in it.
            </p>
          </div>
          <div className="mx-auto mt-6 w-full max-w-md">
            <ApiKeyForm
              autoFocus
              onSaved={() => {
                setConfigured(null);
                loadList();
              }}
            />
            <p className="mt-2 text-center text-xs text-kumo-subtle">
              Stored in the app&rsquo;s database. Setting AGENTMAIL_API_KEY in the deployment
              environment works too, and wins when both exist.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-dvh min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-kumo-hairline px-3 py-2.5 md:px-5">
        <MobileSidebarButton inline onOpenSidebar={onOpenSidebar} />
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-sm font-semibold">
            Email
            {account !== null && (
              <span className="truncate font-mono text-xs font-normal text-kumo-subtle">
                {account.emailAddress}
              </span>
            )}
          </h1>
          <p className="text-xs text-kumo-subtle">
            {account === null
              ? "\u00a0"
              : account.inboundReady
                ? `${AGENT_NAME} is notified the moment mail arrives here.`
                : `${AGENT_NAME} checks this inbox on a schedule.`}
          </p>
        </div>
        <div className="ms-auto flex items-center gap-1">
          {account !== null && <CopyAddressButton address={account.emailAddress} />}
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={GlobeSimpleIcon}
            aria-label="Custom domain"
            title="Custom domain: put the address on a domain you own"
            onClick={() => setDomainOpen(true)}
          />
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={KeyIcon}
            aria-label="AgentMail API key"
            title="AgentMail API key"
            onClick={() => setKeyOpen(true)}
          />
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={ArrowClockwiseIcon}
            aria-label="Refresh"
            title="Refresh"
            disabled={refreshing}
            onClick={() => loadList({ silent: true })}
          />
          <Button variant="primary" size="sm" onClick={() => setComposeOpen(true)}>
            <PaperPlaneTiltIcon className="size-3.5" aria-hidden />
            Compose
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          className="hidden w-44 shrink-0 flex-col gap-0.5 border-e border-kumo-hairline p-2 md:flex"
          aria-label="Mailboxes"
        >
          {FOLDERS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              aria-current={folder === value}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-sm",
                folder === value
                  ? "bg-kumo-tint font-medium text-kumo-strong"
                  : "text-kumo-default hover:bg-kumo-tint/60",
              )}
              onClick={() => {
                setFolder(value);
                setSelectedId(null);
              }}
            >
              <Icon className="size-4 shrink-0 text-kumo-subtle" aria-hidden />
              <span className="truncate">{label}</span>
              {value === "unread" && (list?.unreadCount ?? 0) > 0 && (
                <span className="ms-auto text-xs font-medium text-kumo-brand">
                  {list?.unreadCount}
                </span>
              )}
            </button>
          ))}
        </nav>

        <section
          className={cn(
            "flex min-h-0 w-full shrink-0 flex-col border-e border-kumo-hairline md:w-80 lg:w-96",
            // On narrow screens the reading pane takes over the whole column.
            selectedId !== null && "hidden md:flex",
          )}
          aria-label="Conversations"
        >
          <div className="shrink-0 border-b border-kumo-hairline p-2">
            <div className="relative">
              <MagnifyingGlassIcon
                className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-kumo-subtle"
                aria-hidden
              />
              <Input
                size="sm"
                value={search}
                placeholder="Search all mail"
                aria-label="Search all mail"
                className="w-full ps-7 pe-7 ring-kumo-hairline"
                onChange={(event) => setSearch(event.target.value)}
              />
              {search.length > 0 && (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="absolute end-1.5 top-1/2 -translate-y-1/2 text-kumo-subtle hover:text-kumo-default"
                  onClick={() => setSearch("")}
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </div>
            <div className="mt-1.5 flex gap-1 overflow-x-auto md:hidden">
              {FOLDERS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-1 text-xs",
                    folder === value
                      ? "bg-kumo-tint font-medium text-kumo-strong"
                      : "text-kumo-subtle",
                  )}
                  onClick={() => {
                    setFolder(value);
                    setSelectedId(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {list === null ? (
              <div className="flex justify-center py-10">
                <Loader size={18} />
              </div>
            ) : listError !== null ? (
              <p className="px-4 py-10 text-center text-sm text-kumo-danger">{listError}</p>
            ) : list.threads.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-kumo-subtle">
                {query.length > 0
                  ? `Nothing matches “${query}”.`
                  : folder === "sent"
                    ? `${AGENT_NAME} hasn’t sent any email yet.`
                    : folder === "unread"
                      ? "No unread mail."
                      : folder === "trash"
                        ? "Trash is empty."
                        : "No mail yet. Send something to the address above to see it here."}
              </p>
            ) : (
              <ul className="flex flex-col">
                {list.threads.map((item) => (
                  <li key={item.threadId}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full flex-col gap-0.5 border-b border-kumo-hairline px-3 py-2.5 text-start",
                        item.threadId === selectedId ? "bg-kumo-tint" : "hover:bg-kumo-tint/50",
                      )}
                      onClick={() => setSelectedId(item.threadId)}
                    >
                      <span className="flex items-center gap-2">
                        {item.unread && (
                          <span
                            className="size-1.5 shrink-0 rounded-full bg-kumo-brand"
                            role="status"
                            aria-label="Unread"
                          />
                        )}
                        <span
                          className={cn(
                            "truncate text-sm",
                            item.unread && "font-semibold text-kumo-strong",
                          )}
                        >
                          {item.correspondents.map(displayName).join(", ") || "(unknown sender)"}
                        </span>
                        <span className="ms-auto shrink-0 text-[11px] text-kumo-subtle">
                          {formatListDate(item.timestamp)}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn("truncate text-xs", item.unread && "font-medium")}
                        >
                          {item.subject.length > 0 ? item.subject : "(no subject)"}
                        </span>
                        {item.messageCount > 1 && (
                          <span className="shrink-0 text-[11px] text-kumo-subtle">
                            {item.messageCount}
                          </span>
                        )}
                        {item.attachmentCount > 0 && (
                          <PaperclipIcon
                            className="size-3 shrink-0 text-kumo-subtle"
                            aria-label="Has attachments"
                          />
                        )}
                      </span>
                      <span className="truncate text-xs text-kumo-subtle">{item.preview}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col",
            selectedId === null && "hidden md:flex",
          )}
          aria-label="Conversation"
        >
          {selectedId === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-kumo-subtle">
              <EnvelopeOpenIcon className="size-7" aria-hidden />
              <p className="text-sm">Pick a conversation to read it.</p>
            </div>
          ) : threadError !== null ? (
            <p className="px-6 py-10 text-center text-sm text-kumo-danger">{threadError}</p>
          ) : thread === null ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader size={18} />
            </div>
          ) : (
            <>
              <div className="shrink-0 border-b border-kumo-hairline px-3 py-3 md:px-5">
                <div className="mx-auto flex w-full max-w-3xl items-start gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    icon={CaretLeftIcon}
                    className="md:hidden"
                    aria-label="Back to conversations"
                    onClick={() => setSelectedId(null)}
                  />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold">
                      {thread.subject.length > 0 ? thread.subject : "(no subject)"}
                    </h2>
                    <p className="mt-0.5 text-xs text-kumo-subtle">
                      {thread.messages.length}{" "}
                      {thread.messages.length === 1 ? "message" : "messages"}
                      {thread.labels
                        .filter((label) => label !== "unread")
                        .slice(0, 4)
                        .map((label) => ` · ${label}`)
                        .join("")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    icon={ArrowUUpLeftIcon}
                    aria-label="Mark unread"
                    title="Mark unread"
                    onClick={() => markUnread(thread.threadId)}
                  />
                  {thread.labels.includes("trash") ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setLabels(thread.threadId, { remove: ["trash"] });
                        setSelectedId(null);
                      }}
                    >
                      Restore
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      icon={TrashIcon}
                      aria-label="Move to trash"
                      title="Move to trash"
                      onClick={() => trashThread(thread.threadId)}
                    />
                  )}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 md:px-5">
                {/* Capped so bodies stay readable instead of sprawling on a wide pane. */}
                <div className="mx-auto w-full max-w-3xl">
                  {thread.messages.map((message, index) => (
                    <MessageCard
                      key={message.messageId}
                      message={message}
                      // Long threads open collapsed except for the newest message.
                      expandedByDefault={
                        thread.messages.length <= 3 || index === thread.messages.length - 1
                      }
                    />
                  ))}
                </div>
              </div>

              <ReplyBox
                thread={thread}
                onSent={() => {
                  loadList({ silent: true });
                  setThreadRevision((revision) => revision + 1);
                }}
              />
            </>
          )}
        </section>
      </div>

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={() => {
          setFolder("sent");
          loadList({ silent: true });
        }}
      />

      <DomainDialog
        open={domainOpen}
        onOpenChange={setDomainOpen}
        onChanged={() => loadList({ silent: true })}
      />

      <ApiKeyDialog
        open={keyOpen}
        onOpenChange={setKeyOpen}
        onChanged={() => {
          setConfigured(null);
          loadList();
        }}
      />
    </main>
  );
}

function MobileSidebarButton({
  onOpenSidebar,
  inline = false,
}: {
  onOpenSidebar: () => void;
  inline?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={SidebarSimpleIcon}
      className={cn("md:hidden", !inline && "absolute start-2 top-2 z-20")}
      aria-label="Open threads"
      onClick={onOpenSidebar}
    />
  );
}
