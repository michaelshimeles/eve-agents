"use client";

import { Badge, Button, Checkbox, Input, Loader } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CreditCardIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { AGENT_NAME } from "@/lib/identity";

// Manage -> Card: the owner enters an email or E.164 phone number, receives a
// one-time code, explicitly consents, and completes the connection in place.
// No Agentcard credential or token is ever handled by this component.

interface CardStatus {
  connected: boolean;
  connectedAt: string | null;
  canConnect: boolean;
  unavailableReason: "database" | "credentials" | null;
  dashboardUrl: string;
  termsVersion: string;
  authRequired: boolean;
  authConfigured: boolean;
}

interface ApiFailure {
  error?: {
    code?: string;
    message?: string;
    docs?: string;
  };
  retryCode?: boolean;
  restart?: boolean;
}

const CARD_TOKEN_KEY = "eve:card-admin-token";

function storedCardToken(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(CARD_TOKEN_KEY) ?? "";
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

async function readFailure(response: Response, fallback: string): Promise<ApiFailure> {
  try {
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: { message: fallback } };
    }
    const record = parsed as Record<string, unknown>;
    const rawError = record.error;
    if (typeof rawError === "string") {
      return { error: { message: rawError } };
    }
    const error =
      rawError !== null && typeof rawError === "object" && !Array.isArray(rawError)
        ? (rawError as Record<string, unknown>)
        : {};
    return {
      error: {
        ...(typeof error.code === "string" ? { code: error.code } : {}),
        message: typeof error.message === "string" ? error.message : fallback,
        ...(typeof error.docs === "string" ? { docs: error.docs } : {}),
      },
      ...(record.retryCode === true ? { retryCode: true } : {}),
      ...(record.restart === true ? { restart: true } : {}),
    };
  } catch {
    return { error: { message: fallback } };
  }
}

function ConnectWithAgentcard({
  authRequired,
  authConfigured,
  termsVersion,
  onConnected,
}: {
  authRequired: boolean;
  authConfigured: boolean;
  termsVersion: string;
  onConnected: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "verifying">("idle");
  const [contact, setContact] = useState("");
  const [deliveryChannel, setDeliveryChannel] = useState<"email" | "phone" | null>(null);
  const [code, setCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [draftToken, setDraftToken] = useState("");

  useEffect(() => {
    setToken(storedCardToken());
  }, []);

  function post(path: string, body: unknown): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json" });
    if (token.length > 0) headers.set("x-card-admin-token", token);
    return fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  function handleAuthFailure(response: Response, failure: ApiFailure) {
    if (
      response.status !== 401 ||
      failure.error?.code === "invalid_code"
    ) {
      return;
    }
    window.sessionStorage.removeItem(CARD_TOKEN_KEY);
    setToken("");
  }

  function sendCode() {
    const destination = contact.trim();
    if (destination.length === 0) {
      setError("Enter your email or E.164 phone number.");
      return;
    }
    const target = destination.startsWith("+")
      ? { phone: destination }
      : { email: destination };
    setPhase("sending");
    setError(null);
    void post("/api/agentcard/connect/start", target)
      .then(async (response) => {
        if (!response.ok) {
          const failure = await readFailure(response, "Couldn’t send the code.");
          handleAuthFailure(response, failure);
          setError(failure.error?.message ?? "Couldn’t send the code.");
          setPhase("idle");
          return;
        }
        const body = (await response.json()) as {
          channel?: "email" | "phone";
        };
        setDeliveryChannel(body.channel ?? (destination.startsWith("+") ? "phone" : "email"));
        setCode("");
        setConsent(false);
        setPhase("sent");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Couldn’t send the code.");
        setPhase("idle");
      });
  }

  function verify() {
    setPhase("verifying");
    setError(null);
    void post("/api/agentcard/connect/verify", {
      code: code.trim(),
      consent,
    })
      .then(async (response) => {
        if (!response.ok) {
          const failure = await readFailure(response, "That code didn’t work.");
          handleAuthFailure(response, failure);
          setError(failure.error?.message ?? "That code didn’t work.");
          if (failure.restart === true) {
            setCode("");
            setConsent(false);
            setDeliveryChannel(null);
            setPhase("idle");
          } else {
            setPhase("sent");
          }
          return;
        }
        onConnected();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "That code didn’t work.");
        setPhase("sent");
      });
  }

  if (authRequired && token.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-pretty text-xs text-kumo-subtle">
          {authConfigured
            ? "Enter this deployment’s card admin token to connect. It’s the value of "
            : "Connecting is locked until this deployment sets "}
          <code className="font-mono">AGENTCARD_ADMIN_TOKEN</code>
          {authConfigured ? "." : ", then enter that value here."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-56 font-mono"
            size="sm"
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

  return (
    <div className="flex flex-col gap-2">
      {error !== null && (
        <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-pretty text-sm text-kumo-danger">
          {error}
        </p>
      )}

      {phase === "idle" || phase === "sending" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-72"
            size="sm"
            type="text"
            autoComplete="off"
            placeholder="you@example.com or +15551234567"
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            aria-label="Agentcard email or phone number"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={phase === "sending" || contact.trim().length === 0}
            onClick={sendCode}
          >
            {phase === "sending" ? "Sending…" : "Send code"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-pretty text-xs text-kumo-subtle">
            Code sent by {deliveryChannel ?? "your chosen channel"}. Enter it below.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-32 font-mono tabular-nums"
              size="sm"
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
              disabled={phase === "verifying" || code.trim().length === 0 || !consent}
              onClick={verify}
            >
              {phase === "verifying" ? "Checking…" : "Connect"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={phase === "verifying"}
              onClick={sendCode}
            >
              Resend
            </Button>
          </div>
          <Checkbox
            checked={consent}
            onCheckedChange={setConsent}
            label={
              <span className="text-pretty text-xs text-kumo-subtle">
                I authorize {AGENT_NAME} to connect to my Agentcard account and accept the{" "}
                <a
                  href="https://www.agentcard.sh/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-kumo-interact hover:underline"
                >
                  Agentcard and card issuer terms
                </a>{" "}
                ({termsVersion}). By connecting, I also agree to{" "}
                <a
                  href="https://www.crossmint.com/legal/privacy-policy"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-kumo-interact hover:underline"
                >
                  Crossmint&apos;s Privacy Policy
                </a>
                ; Crossmint may process payments when I add funds.
              </span>
            }
          />
        </div>
      )}
    </div>
  );
}

export function CardPanel() {
  const [status, setStatus] = useState<CardStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [connectedNotice, setConnectedNotice] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/agentcard")
      .then(async (response) => {
        if (!response.ok) {
          const failure = await readFailure(response, "Couldn’t read the card connection.");
          throw new Error(failure.error?.message ?? "Couldn’t read the card connection.");
        }
        return response.json() as Promise<CardStatus>;
      })
      .then(setStatus)
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : "Couldn’t read the card connection.");
      });
  }, []);

  function connected() {
    setStatus((previous) =>
      previous === null
        ? previous
        : { ...previous, connected: true, connectedAt: new Date().toISOString() },
    );
    setConnectedNotice(true);
  }

  function disconnect() {
    setBusy(true);
    const headers = new Headers();
    const token = storedCardToken();
    if (token.length > 0) headers.set("x-card-admin-token", token);
    void fetch("/api/agentcard", { method: "DELETE", headers })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 401) window.sessionStorage.removeItem(CARD_TOKEN_KEY);
          const failure = await readFailure(response, "Disconnect failed.");
          throw new Error(failure.error?.message ?? "Disconnect failed.");
        }
        setStatus((previous) =>
          previous === null
            ? previous
            : { ...previous, connected: false, connectedAt: null },
        );
        setConnectedNotice(false);
      })
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : "Disconnect failed.");
      })
      .finally(() => setBusy(false));
  }

  if (status === null && failed === null) {
    return (
      <div className="flex justify-center py-8">
        <Loader size={18} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {connectedNotice && (
        <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-pretty text-sm">
          Agentcard connected. {AGENT_NAME} can create cards and pay for things now.
        </p>
      )}
      {failed !== null && (
        <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-pretty text-sm text-kumo-danger">
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
          <p className="mt-1 text-pretty text-xs text-kumo-subtle">
            Virtual Visa cards {AGENT_NAME} can spend, each with a fixed limit drawn from your cash
            balance — so she can pay for things without ever holding your real card.
            {status?.connected === true && status.connectedAt !== null && (
              <> Connected {formatWhen(status.connectedAt)}.</>
            )}
          </p>
        </div>
      </div>

      {status?.canConnect === false ? (
        <p className="text-pretty text-xs text-kumo-subtle">
          {status.unavailableReason === "database" ? (
            <>
              Connecting Agentcard needs a database to store the encrypted connection. Set{" "}
              <code className="font-mono">DATABASE_URL</code> and reload.
            </>
          ) : (
            <>
              Set <code className="font-mono">AGENTCARD_CLIENT_ID</code> and{" "}
              <code className="font-mono">AGENTCARD_CLIENT_SECRET</code> as backend environment
              variables, then reload.
            </>
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <ConnectWithAgentcard
            authRequired={status?.authRequired ?? false}
            authConfigured={status?.authConfigured ?? false}
            termsVersion={status?.termsVersion ?? ""}
            onConnected={connected}
          />
          {status?.connected === true && (
            <div className="flex flex-wrap items-center gap-3">
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
                <ArrowSquareOutIcon className="size-3.5" aria-hidden />
              </a>
            </div>
          )}
        </div>
      )}

      {status?.connected === true ? (
        <p className="text-pretty text-xs text-kumo-subtle">
          Ask {AGENT_NAME} to add funds and she’ll send you an Apple Pay / Google Pay link, or top
          up on the Agentcard dashboard. Creating a card and any purchase pause for your approval
          in chat first.
        </p>
      ) : (
        <p className="text-pretty text-xs text-kumo-subtle">
          A one-time code completes the connection here. You won’t be redirected to an Agentcard
          sign-in page.
        </p>
      )}
    </div>
  );
}
