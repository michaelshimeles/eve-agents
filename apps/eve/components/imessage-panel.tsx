"use client";

import { Badge, Button, Input, Loader } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, ChatCircleDotsIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { AGENT_NAME } from "@/lib/identity";

// Manage -> iMessage: pair this deployment with the owner's phone number on
// the shared Ruth line. Pairing is an OTP round trip: the router texts a
// 6-digit code from the shared number, the owner types it here, and from
// then on texts from that number reach this deployment (and only this one).

interface PairingState {
  status: "unpaired" | "pending" | "verified";
  handle: string | null;
  routerUrl: string | null;
  verifiedAt: string | null;
}

interface IMessageStatus {
  hasDatabase: boolean;
  isRouter: boolean;
  routerUrl: string | null;
  pairing: PairingState;
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

function formatWhen(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" });
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

function TranscriptUnlock({
  configured,
  draft,
  failed,
  onDraft,
  onUnlock,
}: {
  configured: boolean;
  draft: string;
  failed: string | null;
  onDraft: (value: string) => void;
  onUnlock: () => void;
}) {
  return (
    <section className="border-t border-kumo-hairline pt-4" aria-labelledby="imessage-log-title">
      <p id="imessage-log-title" className="text-sm font-medium text-balance">
        Conversation log
      </p>
      <p className="mt-1 text-xs text-kumo-subtle text-pretty">
        Private message contents are protected separately from this open web app.
      </p>

      {failed !== null ? (
        <p
          className="mt-3 rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm text-kumo-danger"
          role="alert"
        >
          {failed}
        </p>
      ) : null}

      {configured ? (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onUnlock();
          }}
        >
          <Input
            type="password"
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            placeholder="iMessage admin token"
            aria-label="iMessage admin token"
            autoComplete="off"
          />
          <Button type="submit" variant="primary" size="sm" disabled={draft.trim().length === 0}>
            Unlock
          </Button>
        </form>
      ) : (
        <p className="mt-3 text-xs text-kumo-subtle text-pretty">
          Set <code className="font-mono">IMESSAGE_ADMIN_TOKEN</code> on this deployment to enable
          the log.
        </p>
      )}
    </section>
  );
}

function TranscriptLog({
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
    <section className="border-t border-kumo-hairline pt-4" aria-labelledby="imessage-log-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p id="imessage-log-title" className="text-sm font-medium text-balance">
            Conversation log
          </p>
          <p className="mt-1 text-xs text-kumo-subtle text-pretty">
            The latest provider-facing messages and delivery state. Stored in this deployment&rsquo;s
            database for debugging.
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
          className="mt-3 rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm text-kumo-danger"
          role="alert"
        >
          {failed}
        </p>
      ) : null}

      {loading && entries.length === 0 ? (
        <div className="mt-3 flex flex-col gap-2" aria-label="Loading conversation log">
          <div className="h-14 rounded-lg bg-kumo-recessed" />
          <div className="h-14 rounded-lg bg-kumo-recessed" />
          <div className="h-14 rounded-lg bg-kumo-recessed" />
        </div>
      ) : entries.length === 0 ? (
        <p className="mt-3 rounded-lg border border-kumo-hairline px-3 py-3 text-sm text-kumo-subtle text-pretty">
          No messages logged yet. Send {AGENT_NAME} an iMessage, then refresh this log.
        </p>
      ) : (
        <ol
          className="mt-3 max-h-96 divide-y divide-kumo-hairline overflow-y-auto rounded-lg border border-kumo-hairline"
          aria-label="iMessage conversation log, newest first"
        >
          {entries.map((entry) => (
            <li key={entry.id} className="px-3 py-2.5">
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

export function IMessagePanel() {
  const [status, setStatus] = useState<IMessageStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [transcriptFailed, setTranscriptFailed] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(true);
  const [transcriptToken, setTranscriptToken] = useState(storedTranscriptToken);
  const [draftTranscriptToken, setDraftTranscriptToken] = useState("");
  const transcriptRequestRef = useRef(0);

  function rejectTranscriptToken(error: unknown): void {
    if (error instanceof TranscriptFetchError && error.status === 401) {
      window.sessionStorage.removeItem(TRANSCRIPT_TOKEN_KEY);
      setTranscriptToken("");
    }
  }

  useEffect(() => {
    let active = true;
    const transcriptRequestId = ++transcriptRequestRef.current;
    void Promise.allSettled([fetchStatus(), fetchTranscript(transcriptToken)]).then(
      ([statusResult, transcriptResult]) => {
        if (!active) return;
        if (statusResult.status === "fulfilled") {
          setStatus(statusResult.value);
        } else {
          setFailed(
            statusResult.reason instanceof Error
              ? statusResult.reason.message
              : "Couldn't read the iMessage state.",
          );
        }
        if (transcriptRequestId === transcriptRequestRef.current) {
          if (transcriptResult.status === "fulfilled") {
            setTranscript(transcriptResult.value);
            setTranscriptFailed(null);
          } else {
            rejectTranscriptToken(transcriptResult.reason);
            setTranscriptFailed(
              transcriptResult.reason instanceof Error
                ? transcriptResult.reason.message
                : "Couldn't read the conversation log.",
            );
          }
          setTranscriptLoading(false);
        }
      });
    return () => {
      active = false;
      transcriptRequestRef.current += 1;
    };
  }, []);

  function refreshTranscript(token = transcriptToken): void {
    const requestId = ++transcriptRequestRef.current;
    setTranscriptLoading(true);
    setTranscriptFailed(null);
    void fetchTranscript(token)
      .then((entries) => {
        if (requestId !== transcriptRequestRef.current) return;
        setTranscript(entries);
      })
      .catch((error: unknown) => {
        if (requestId !== transcriptRequestRef.current) return;
        rejectTranscriptToken(error);
        setTranscriptFailed(
          error instanceof Error ? error.message : "Couldn't read the conversation log.",
        );
      })
      .finally(() => {
        if (requestId === transcriptRequestRef.current) setTranscriptLoading(false);
      });
  }

  function act(action: string, extra: Record<string, string> = {}, doneNotice?: string) {
    setBusy(action);
    setFailed(null);
    setNotice(null);
    void fetch("/api/imessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { pairing?: PairingState; error?: string }
          | null;
        if (!response.ok) {
          throw new Error(body?.error ?? `That didn't work (HTTP ${response.status}).`);
        }
        if (body?.pairing !== undefined) {
          setStatus((prev) => (prev === null ? prev : { ...prev, pairing: body.pairing! }));
        }
        if (doneNotice !== undefined) setNotice(doneNotice);
        if (action === "verify") setCode("");
        if (action === "test") refreshTranscript();
      })
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : "Request failed.");
      })
      .finally(() => setBusy(null));
  }

  if (status === null && failed === null) {
    return (
      <div className="flex justify-center py-8">
        <Loader size={18} />
      </div>
    );
  }

  const pairing = status?.pairing ?? null;
  const paired = pairing?.status === "verified";
  const pending = pairing?.status === "pending";

  return (
    <div className="flex flex-col gap-4">
      {notice !== null && (
        <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {failed !== null && (
        <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm text-kumo-danger">
          {failed}
        </p>
      )}

      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-recessed">
          <ChatCircleDotsIcon className="size-4 text-kumo-subtle" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">iMessage</p>
            {pairing !== null && (
              <Badge variant={paired ? "success" : "secondary"}>
                {paired ? "paired" : pending ? "code sent" : "not paired"}
              </Badge>
            )}
            {status?.isRouter === true && <Badge variant="secondary">router</Badge>}
          </div>
          <p className="mt-1 text-xs text-kumo-subtle">
            Text {AGENT_NAME} from your own phone over iMessage. Every deployment shares one
            number; pairing tells the router which texts are yours.
            {paired && pairing?.handle !== null && (
              <>
                {" "}
                Paired with <span className="font-mono">{pairing.handle}</span>
                {pairing.verifiedAt !== null && <> since {formatWhen(pairing.verifiedAt)}</>}.
              </>
            )}
          </p>
        </div>
      </div>

      {status?.hasDatabase === false ? (
        <p className="text-xs text-kumo-subtle">
          Pairing needs a database to store its state. Set{" "}
          <code className="font-mono">DATABASE_URL</code> and reload.
        </p>
      ) : status?.routerUrl === null && !paired ? (
        <p className="text-xs text-kumo-subtle">
          No iMessage router is reachable from this deployment. Set{" "}
          <code className="font-mono">IMESSAGE_ROUTER_URL</code> to the router deployment, or make
          this deployment the router with <code className="font-mono">SPECTRUM_*</code>{" "}
          credentials.
        </p>
      ) : paired ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => act("test", {}, "Test text sent — check your phone.")}
          >
            {busy === "test" ? "Sending…" : "Send a test text"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => act("unpair", {}, "Unpaired. Texts from that number are strangers now.")}
          >
            {busy === "unpair" ? "Unpairing…" : "Unpair"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              size="sm"
              value={handle}
              aria-label="Your phone number"
              placeholder="+1 555 123 4567"
              className="w-56"
              onChange={(event) => setHandle(event.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy !== null || handle.trim().length === 0}
              onClick={() =>
                act("start", { handle }, "Code texted from the shared number — enter it below.")
              }
            >
              {busy === "start" ? "Texting…" : pending ? "Resend code" : "Text me a code"}
            </Button>
          </div>
          {pending && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                size="sm"
                value={code}
                aria-label="Pairing code"
                placeholder="6-digit code"
                className="w-36 font-mono"
                onChange={(event) => setCode(event.target.value)}
              />
              <Button
                variant="primary"
                size="sm"
                disabled={busy !== null || code.trim().length !== 6}
                onClick={() => act("verify", { code }, `Paired. Text the number any time — that's ${AGENT_NAME}.`)}
              >
                {busy === "verify" ? "Checking…" : "Pair"}
              </Button>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-kumo-subtle">
        Your number (or an iMessage email) gets a 6-digit code texted from {AGENT_NAME}&rsquo;s
        shared line. DMs work only from the number paired here. Group chats work too: add{" "}
        {AGENT_NAME}&rsquo;s number to a group and send the first message yourself — that unlocks
        the group, and then everyone in it can talk to {AGENT_NAME}. Sensitive requests still
        need your go-ahead.
      </p>

      {status?.hasDatabase === true ? (
        status.transcriptAuth?.authRequired === true && transcriptToken.length === 0 ? (
          <TranscriptUnlock
            configured={status.transcriptAuth.authConfigured}
            draft={draftTranscriptToken}
            failed={transcriptFailed}
            onDraft={setDraftTranscriptToken}
            onUnlock={() => {
              const token = draftTranscriptToken.trim();
              window.sessionStorage.setItem(TRANSCRIPT_TOKEN_KEY, token);
              setTranscriptToken(token);
              setDraftTranscriptToken("");
              setTranscriptFailed(null);
              refreshTranscript(token);
            }}
          />
        ) : (
          <TranscriptLog
            entries={transcript}
            failed={transcriptFailed}
            loading={transcriptLoading}
            onRefresh={refreshTranscript}
          />
        )
      ) : null}
    </div>
  );
}
