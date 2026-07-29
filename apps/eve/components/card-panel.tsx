"use client";

import { Badge, Button, Loader } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CreditCardIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { AGENT_NAME } from "@/lib/identity";

// Manage -> Card: the one place the owner hands Ruth a means of payment.
// Personal mode connects with an OAuth round trip through Agentcard, so that
// button is a plain navigation to /api/agentcard/connect rather than a fetch;
// the callback lands back here with ?card=connected or ?card=error&message=...
// Company mode (this deployment holds company credentials) connects in place:
// a code is emailed to the env-pinned owner address and entered right here.

interface CardStatus {
  connected: boolean;
  connectedAt: string | null;
  /** False when there is no database to store the connection in. */
  canConnect: boolean;
  dashboardUrl: string;
  /** Company mode connects with an emailed code instead of a browser redirect. */
  mode: "personal" | "company";
  /** Where the code goes, masked for display; null when the env var is unset. */
  ownerEmailMasked: string | null;
  /** Company connect routes carry their own admin gate (lib/card-auth.ts). */
  authRequired: boolean;
  authConfigured: boolean;
}

const CARD_TOKEN_KEY = "eve:card-admin-token";

function storedCardToken(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(CARD_TOKEN_KEY) ?? "";
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

/**
 * The company-mode connect (and reconnect) flow: request a code, enter it.
 * The email is pinned server-side; this form never collects an address.
 */
function CompanyConnect({
  ownerEmailMasked,
  authRequired,
  authConfigured,
  onConnected,
}: {
  ownerEmailMasked: string | null;
  authRequired: boolean;
  authConfigured: boolean;
  onConnected: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "verifying">("idle");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [draftToken, setDraftToken] = useState("");

  useEffect(() => {
    setToken(storedCardToken());
  }, []);

  /** A 401 means the remembered token went stale; ask for it again. */
  function handleFailure(response: Response, fallback: string, retryPhase: "idle" | "sent") {
    return response.text().then((message) => {
      if (response.status === 401) {
        window.sessionStorage.removeItem(CARD_TOKEN_KEY);
        setToken("");
      }
      setError(message.length > 0 ? message : fallback);
      setPhase(retryPhase);
    });
  }

  function post(path: string, body?: unknown): Promise<Response> {
    const headers = new Headers();
    if (body !== undefined) headers.set("content-type", "application/json");
    if (token.length > 0) headers.set("x-card-admin-token", token);
    return fetch(path, {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function sendCode() {
    setPhase("sending");
    setError(null);
    void post("/api/agentcard/connect/start")
      .then(async (response) => {
        if (!response.ok) return handleFailure(response, "Couldn't send the code.", "idle");
        setPhase("sent");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Couldn't send the code.");
        setPhase("idle");
      });
  }

  function verify() {
    setPhase("verifying");
    setError(null);
    void post("/api/agentcard/connect/verify", { code: code.trim() })
      .then(async (response) => {
        if (!response.ok) return handleFailure(response, "That code didn't work.", "sent");
        onConnected();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "That code didn't work.");
        setPhase("sent");
      });
  }

  if (authRequired && token.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-kumo-subtle">
          {authConfigured
            ? "Enter this deployment's card admin token to connect. It's the value of "
            : "Connecting is locked until this deployment sets "}
          <code className="font-mono">AGENTCARD_ADMIN_TOKEN</code>
          {authConfigured ? "." : ", then enter that value here."}
        </p>
        <div className="flex items-center gap-2">
          <input
            className="w-56 rounded-lg border border-kumo-hairline bg-transparent px-2 py-1 font-mono text-sm"
            type="password"
            autoComplete="off"
            placeholder="Admin token"
            value={draftToken}
            onChange={(event) => setDraftToken(event.target.value)}
            aria-label="Card admin token"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={draftToken.trim().length === 0}
            onClick={() => {
              window.sessionStorage.setItem(CARD_TOKEN_KEY, draftToken.trim());
              setToken(draftToken.trim());
              setDraftToken("");
              setError(null);
            }}
          >
            Unlock
          </Button>
        </div>
      </div>
    );
  }

  if (ownerEmailMasked === null) {
    return (
      <p className="text-xs text-kumo-subtle">
        Set <code className="font-mono">AGENTCARD_OWNER_EMAIL</code> so the sign-in code has
        somewhere to go, then reload.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error !== null && (
        <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm text-kumo-danger">
          {error}
        </p>
      )}
      {phase === "idle" || phase === "sending" ? (
        <div>
          <Button variant="primary" size="sm" disabled={phase === "sending"} onClick={sendCode}>
            {phase === "sending" ? "Sending…" : `Email a code to ${ownerEmailMasked}`}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="w-32 rounded-lg border border-kumo-hairline bg-transparent px-2 py-1 font-mono text-sm"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-label="One-time code"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={phase === "verifying" || code.trim().length === 0}
            onClick={verify}
          >
            {phase === "verifying" ? "Checking…" : "Connect"}
          </Button>
          <Button variant="secondary" size="sm" disabled={phase === "verifying"} onClick={sendCode}>
            Resend
          </Button>
        </div>
      )}
    </div>
  );
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
    const headers = new Headers();
    // Company mode gates disconnect behind the same admin token as connect.
    const token = status?.mode === "company" ? storedCardToken() : "";
    if (token.length > 0) headers.set("x-card-admin-token", token);
    void fetch("/api/agentcard", { method: "DELETE", headers })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 401) window.sessionStorage.removeItem(CARD_TOKEN_KEY);
          throw new Error(await response.text());
        }
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
                  stored grant (revoked from their side, say). In company mode
                  that is a fresh emailed code rather than a browser trip. */}
              {status.mode === "company" ? (
                <CompanyConnect
                  ownerEmailMasked={status.ownerEmailMasked}
                  authRequired={status.authRequired}
                  authConfigured={status.authConfigured}
                  onConnected={() => {
                    setStatus((prev) =>
                      prev === null
                        ? prev
                        : { ...prev, connected: true, connectedAt: new Date().toISOString() },
                    );
                    setOutcome({ kind: "connected", message: null });
                  }}
                />
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    window.location.href = "/api/agentcard/connect";
                  }}
                >
                  Reconnect
                </Button>
              )}
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
          ) : status?.mode === "company" ? (
            <CompanyConnect
              ownerEmailMasked={status.ownerEmailMasked}
              authRequired={status.authRequired}
              authConfigured={status.authConfigured}
              onConnected={() => {
                setStatus((prev) =>
                  prev === null
                    ? prev
                    : { ...prev, connected: true, connectedAt: new Date().toISOString() },
                );
                setOutcome({ kind: "connected", message: null });
              }}
            />
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
        status?.mode === "company" ? (
          <p className="text-xs text-kumo-subtle">
            A one-time code goes to your email — no browser sign-in. You can also just ask{" "}
            {AGENT_NAME} to connect and read her the code.
          </p>
        ) : (
          <p className="text-xs text-kumo-subtle">
            You&rsquo;ll sign in to Agentcard in the browser — no API key to paste, no CLI.
            Don&rsquo;t have an account? One is created as part of signing in.
          </p>
        )
      )}
    </div>
  );
}
