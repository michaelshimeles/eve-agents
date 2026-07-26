"use client";

import { Badge, Button, Input, Loader } from "@cloudflare/kumo";
import { ChatCircleDotsIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

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
}

function formatWhen(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function IMessagePanel() {
  const [status, setStatus] = useState<IMessageStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/imessage")
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<IMessageStatus>;
      })
      .then(setStatus)
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : "Couldn't read the iMessage state.");
      });
  }, []);

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
        shared line. DMs only — group chats are ignored — and {AGENT_NAME} can only ever text the
        number paired here.
      </p>
    </div>
  );
}
