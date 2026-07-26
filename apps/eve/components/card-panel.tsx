"use client";

import { Badge, Button, Loader } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CreditCardIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { AGENT_NAME } from "@/lib/identity";

// Manage -> Card: the one place the owner hands Ruth a means of payment.
// Connecting is an OAuth round trip through Agentcard, so the button is a plain
// navigation to /api/agentcard/connect rather than a fetch; the callback lands
// back here with ?card=connected or ?card=error&message=...

interface CardStatus {
  connected: boolean;
  connectedAt: string | null;
  /** False when there is no database to store the connection in. */
  canConnect: boolean;
  dashboardUrl: string;
}

/** The outcome the callback route redirected back with, read once on mount. */
function takeCallbackOutcome(): { kind: "connected" | "error"; message: string | null } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const card = params.get("card");
  if (card !== "connected" && card !== "error") return null;

  const message = params.get("message");
  // Clear it so a refresh doesn't replay a stale banner.
  params.delete("card");
  params.delete("message");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query.length > 0 ? `?${query}` : ""}`,
  );
  return { kind: card, message };
}

function formatWhen(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function CardPanel() {
  const [status, setStatus] = useState<CardStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ReturnType<typeof takeCallbackOutcome>>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOutcome(takeCallbackOutcome());
    void fetch("/api/agentcard")
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<CardStatus>;
      })
      .then(setStatus)
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : "Couldn't read the card connection.");
      });
  }, []);

  function disconnect() {
    setBusy(true);
    void fetch("/api/agentcard", { method: "DELETE" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        setStatus((prev) => (prev === null ? prev : { ...prev, connected: false, connectedAt: null }));
        setOutcome(null);
      })
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : "Disconnect failed.");
      })
      .finally(() => setBusy(false));
  }

  if (status === null && failed === null) return <div className="flex justify-center py-8"><Loader size={18} /></div>;

  return (
    <div className="flex flex-col gap-4">
      {outcome?.kind === "connected" && (
        <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm">
          Agentcard connected. {AGENT_NAME} can create cards and pay for things now.
        </p>
      )}
      {outcome?.kind === "error" && (
        <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm text-kumo-danger">
          {outcome.message ?? "That sign-in didn't complete."}
        </p>
      )}
      {failed !== null && (
        <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm text-kumo-danger">
          {failed}
        </p>
      )}

      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-recessed">
          <CreditCardIcon className="size-4 text-kumo-subtle" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Agentcard</p>
            {status !== null && (
              <Badge variant={status.connected ? "success" : "secondary"}>
                {status.connected ? "connected" : "not connected"}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-kumo-subtle">
            Virtual Visa cards {AGENT_NAME} can spend, each with a fixed limit drawn from your cash
            balance — so she can pay for things without ever holding your real card.
            {status?.connected === true && status.connectedAt !== null && (
              <> Connected {formatWhen(status.connectedAt)}.</>
            )}
          </p>
        </div>
      </div>

      {status?.canConnect === false ? (
        <p className="text-xs text-kumo-subtle">
          Connecting Agentcard needs a database to store the connection. Set{" "}
          <code className="font-mono">DATABASE_URL</code> and reload.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {status?.connected === true ? (
            <>
              {/* Signing in again is the fix when Agentcard stops accepting the
                  stored grant (revoked from their side, say). */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  window.location.href = "/api/agentcard/connect";
                }}
              >
                Reconnect
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={disconnect}>
                {busy ? "Disconnecting…" : "Disconnect"}
              </Button>
              <a
                href={status.dashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-sm font-medium text-kumo-interact hover:underline"
              >
                Add funds & see cards
                <ArrowSquareOutIcon className="size-3.5" />
              </a>
            </>
          ) : (
            // A navigation, not a fetch: the OAuth consent screen has to render
            // in the top-level window, and Agentcard redirects back here.
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                window.location.href = "/api/agentcard/connect";
              }}
            >
              Connect Agentcard
            </Button>
          )}
        </div>
      )}

      {status?.connected === true ? (
        // Literal characters, not HTML entities: an entity anywhere in a text
        // node that follows a JSX expression makes the production transform
        // swallow that node's leading space ("Ask Ruthto add funds").
        <p className="text-xs text-kumo-subtle">
          Ask {AGENT_NAME} to add funds and she’ll send you an Apple Pay / Google Pay link, or top
          up on the Agentcard dashboard. Creating a card and any purchase pause for your approval
          in chat first.
        </p>
      ) : (
        <p className="text-xs text-kumo-subtle">
          You&rsquo;ll sign in to Agentcard in the browser — no API key to paste, no CLI. Don&rsquo;t
          have an account? One is created as part of signing in.
        </p>
      )}
    </div>
  );
}
