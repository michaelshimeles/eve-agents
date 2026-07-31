"use client";

import { Button, Input, LinkButton } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, CaretLeftIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { AGENT_NAME } from "@/lib/identity";

interface IMessageStatus {
  hasDatabase: boolean;
  transcriptAuth?: {
    authRequired: boolean;
    authConfigured: boolean;
  };
}

interface TranscriptAttachment {
  name: string;
  mimeType: string;
}

interface TranscriptEntry {
  id: string;
  direction: "inbound" | "outbound";
  kind: string;
  handle: string;
  role: string | null;
  chatType: "dm" | "group";
  spaceId: string | null;
  phone: string | null;
  messageId: string | null;
  text: string | null;
  attachments: TranscriptAttachment[];
  status: string;
  error: string | null;
  sessionId: string | null;
  occurredAt: string;
  updatedAt: string;
}

const TRANSCRIPT_TOKEN_KEY = "eve:imessage-admin-token";

function storedTranscriptToken(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(TRANSCRIPT_TOKEN_KEY) ?? "";
}

class TranscriptFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TranscriptFetchError";
  }
}

function formatTranscriptWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function fetchStatus(): Promise<IMessageStatus> {
  const response = await fetch("/api/imessage");
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<IMessageStatus>;
}

async function fetchTranscript(token: string): Promise<TranscriptEntry[]> {
  const headers = new Headers();
  if (token.length > 0) headers.set("x-imessage-admin-token", token);
  const response = await fetch("/api/imessage/transcript?limit=100", { headers });
  const body = (await response.json().catch(() => null)) as
    | { entries?: TranscriptEntry[]; error?: string }
    | null;
  if (!response.ok) {
    throw new TranscriptFetchError(
      body?.error ?? `Couldn't read the conversation log (HTTP ${response.status}).`,
      response.status,
    );
  }
  return body?.entries ?? [];
}

function transcriptSpeaker(entry: TranscriptEntry): string {
  if (entry.direction === "outbound") return AGENT_NAME;
  if (entry.role === "owner") return "You";
  return entry.handle;
}

function ConversationLog({
  entries,
  failed,
  loading,
  onRefresh,
}: {
  entries: TranscriptEntry[];
  failed: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <section aria-labelledby="imessage-log-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 id="imessage-log-title" className="text-lg font-semibold text-balance">
            iMessage conversation log
          </h1>
          <p className="mt-1 text-sm text-kumo-subtle text-pretty">
            The latest provider-facing messages and delivery state, stored for debugging.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={ArrowClockwiseIcon}
          aria-label="Refresh conversation log"
          title="Refresh conversation log"
          disabled={loading}
          onClick={onRefresh}
        />
      </div>

      {failed !== null ? (
        <p
          className="mt-4 rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm text-kumo-danger"
          role="alert"
        >
          {failed}
        </p>
      ) : null}

      {loading && entries.length === 0 ? (
        <div className="mt-4 flex flex-col gap-2" aria-label="Loading conversation log">
          <div className="h-20 rounded-lg bg-kumo-recessed" />
          <div className="h-20 rounded-lg bg-kumo-recessed" />
          <div className="h-20 rounded-lg bg-kumo-recessed" />
        </div>
      ) : entries.length === 0 ? (
        <p className="mt-4 rounded-lg border border-kumo-hairline px-3 py-3 text-sm text-kumo-subtle text-pretty">
          No messages logged yet. Send {AGENT_NAME} an iMessage, then refresh this log.
        </p>
      ) : (
        <ol
          className="mt-4 divide-y divide-kumo-hairline rounded-lg border border-kumo-hairline"
          aria-label="iMessage conversation log, newest first"
        >
          {entries.map((entry) => (
            <li key={entry.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <span className="font-medium text-kumo-default">{transcriptSpeaker(entry)}</span>
                <span className="text-kumo-subtle">
                  {entry.chatType === "group" ? "Group" : "DM"} · {entry.kind}
                </span>
                <span
                  className={
                    entry.status === "failed" ? "text-kumo-danger" : "text-kumo-subtle"
                  }
                >
                  {entry.status}
                </span>
                <time
                  className="ms-auto tabular-nums text-kumo-subtle"
                  dateTime={entry.occurredAt}
                >
                  {formatTranscriptWhen(entry.occurredAt)}
                </time>
              </div>

              {entry.text !== null && entry.text.length > 0 ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-pretty">
                  {entry.text}
                </p>
              ) : null}

              {entry.attachments.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-0.5 text-xs text-kumo-subtle">
                  {entry.attachments.map((attachment, index) => (
                    <li key={`${entry.id}:attachment:${index}`} className="break-words">
                      Attachment: {attachment.name} ({attachment.mimeType})
                    </li>
                  ))}
                </ul>
              ) : null}

              {entry.error !== null ? (
                <p className="mt-1 break-words text-xs text-kumo-danger">{entry.error}</p>
              ) : null}

              {entry.sessionId !== null || entry.messageId !== null || entry.spaceId !== null ? (
                <p className="mt-1 truncate font-mono text-[11px] text-kumo-subtle">
                  {[
                    entry.sessionId !== null ? `session ${entry.sessionId}` : null,
                    entry.messageId !== null ? `message ${entry.messageId}` : null,
                    entry.spaceId !== null ? `space ${entry.spaceId}` : null,
                  ]
                    .filter((value): value is string => value !== null)
                    .join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function IMessageTranscriptPage() {
  const [status, setStatus] = useState<IMessageStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(storedTranscriptToken);
  const [draftToken, setDraftToken] = useState("");
  const requestRef = useRef(0);

  function rejectToken(error: unknown): void {
    if (error instanceof TranscriptFetchError && error.status === 401) {
      window.sessionStorage.removeItem(TRANSCRIPT_TOKEN_KEY);
      setToken("");
    }
  }

  useEffect(() => {
    let active = true;
    const requestId = ++requestRef.current;
    void Promise.allSettled([fetchStatus(), fetchTranscript(token)]).then(
      ([statusResult, transcriptResult]) => {
        if (!active) return;
        if (statusResult.status === "fulfilled") {
          setStatus(statusResult.value);
        } else {
          setStatusFailed(
            statusResult.reason instanceof Error
              ? statusResult.reason.message
              : "Couldn't read the iMessage state.",
          );
        }
        if (requestId === requestRef.current) {
          if (transcriptResult.status === "fulfilled") {
            setEntries(transcriptResult.value);
            setFailed(null);
          } else {
            rejectToken(transcriptResult.reason);
            setFailed(
              transcriptResult.reason instanceof Error
                ? transcriptResult.reason.message
                : "Couldn't read the conversation log.",
            );
          }
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
      requestRef.current += 1;
    };
  }, []);

  function refresh(nextToken = token): void {
    const requestId = ++requestRef.current;
    setLoading(true);
    setFailed(null);
    void fetchTranscript(nextToken)
      .then((nextEntries) => {
        if (requestId !== requestRef.current) return;
        setEntries(nextEntries);
      })
      .catch((error: unknown) => {
        if (requestId !== requestRef.current) return;
        rejectToken(error);
        setFailed(error instanceof Error ? error.message : "Couldn't read the conversation log.");
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });
  }

  const needsToken = status?.transcriptAuth?.authRequired === true && token.length === 0;

  return (
    <main className="min-h-dvh bg-kumo-canvas">
      <div className="w-full max-w-3xl px-6 py-6">
        <LinkButton
          href="/manage?tab=imessage"
          variant="ghost"
          size="sm"
          icon={CaretLeftIcon}
          className="-ms-2 mb-5"
        >
          iMessage settings
        </LinkButton>

        {statusFailed !== null ? (
          <p
            className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm text-kumo-danger"
            role="alert"
          >
            {statusFailed}
          </p>
        ) : status?.hasDatabase === false ? (
          <section aria-labelledby="imessage-log-title">
            <h1 id="imessage-log-title" className="text-lg font-semibold text-balance">
              iMessage conversation log
            </h1>
            <p className="mt-4 text-sm text-kumo-subtle text-pretty">
              The conversation log needs a database. Set{" "}
              <code className="font-mono">DATABASE_URL</code> and reload.
            </p>
          </section>
        ) : needsToken ? (
          <section aria-labelledby="imessage-log-title">
            <h1 id="imessage-log-title" className="text-lg font-semibold text-balance">
              iMessage conversation log
            </h1>
            <p className="mt-1 text-sm text-kumo-subtle text-pretty">
              Private message contents are protected separately from this open web app.
            </p>

            {failed !== null ? (
              <p
                className="mt-4 rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm text-kumo-danger"
                role="alert"
              >
                {failed}
              </p>
            ) : null}

            {status.transcriptAuth?.authConfigured === true ? (
              <form
                className="mt-4 flex max-w-md items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const nextToken = draftToken.trim();
                  window.sessionStorage.setItem(TRANSCRIPT_TOKEN_KEY, nextToken);
                  setToken(nextToken);
                  setDraftToken("");
                  setFailed(null);
                  refresh(nextToken);
                }}
              >
                <Input
                  type="password"
                  value={draftToken}
                  onChange={(event) => setDraftToken(event.target.value)}
                  placeholder="iMessage admin token"
                  aria-label="iMessage admin token"
                  autoComplete="off"
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={draftToken.trim().length === 0}
                >
                  Unlock
                </Button>
              </form>
            ) : (
              <p className="mt-4 text-sm text-kumo-subtle text-pretty">
                Set <code className="font-mono">IMESSAGE_ADMIN_TOKEN</code> on this deployment to
                enable the log.
              </p>
            )}
          </section>
        ) : (
          <ConversationLog entries={entries} failed={failed} loading={loading} onRefresh={refresh} />
        )}
      </div>
    </main>
  );
}
