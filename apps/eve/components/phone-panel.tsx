"use client";

import { Badge, Button, Input, Loader } from "@cloudflare/kumo";
import { PhoneIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { AGENT_NAME, OWNER_NAME } from "@/lib/identity";

// Manage -> Phone: paste an AgentPhone key, provision a number, and say whose
// texts count as the owner's. The number is what makes texting, calling, and
// the verification inbox work, so this panel is also the setup instructions —
// it renders before a key exists, which is how you find out you need one.

interface PhoneState {
  numberId: string | null;
  phoneNumber: string | null;
  agentId: string | null;
  webhookRegistered: boolean;
  ownerNumber: string | null;
}

interface Registration {
  campaign_status: string;
  message?: string | null;
  stage?: string | null;
}

interface PhoneStatus {
  enabled: boolean;
  keySource: "env" | "app" | null;
  keyHint?: string | null;
  hasDatabase: boolean;
  phone?: PhoneState | null;
  registration?: Registration | null;
  /** This deployment demands an admin token before it will change anything. */
  authRequired?: boolean;
  /** An AGENTPHONE_ADMIN_TOKEN is actually set, so unlocking is possible. */
  authConfigured?: boolean;
  error?: string;
}

/**
 * The admin token, held for this tab only.
 *
 * sessionStorage rather than localStorage: it dies with the tab, so a shared
 * or borrowed browser does not keep the ability to buy numbers and rotate
 * credentials indefinitely. It is never written to the server except as the
 * header on a request that is about to change something.
 */
const TOKEN_KEY = "eve:phone-admin-token";

function storedToken(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(TOKEN_KEY) ?? "";
}

/** The header button and manage tab key off this; tell them when it flips. */
function announceFeatureChange(): void {
  window.dispatchEvent(new Event("eve:features-changed"));
}

/**
 * The phone feature is parked: the tab stays visible so people know it exists,
 * but the controls are withheld until it ships for real. Swap this back to
 * <PhonePanel /> in manage-panel.tsx to reopen the panel — everything behind
 * it (webhook, channels, API) is still live.
 */
export function PhoneComingSoon() {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-recessed">
        <PhoneIcon className="size-4 text-kumo-subtle" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">Phone</p>
          <Badge variant="secondary">coming soon</Badge>
        </div>
        <p className="mt-1 text-xs text-kumo-subtle">
          A number of {AGENT_NAME}&rsquo;s own: she&rsquo;ll text and iMessage people, make and
          take calls, and read verification codes sent to it. It&rsquo;s not ready yet — check
          back soon.
        </p>
      </div>
    </div>
  );
}

export function PhonePanel() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [token, setToken] = useState("");
  const [draftToken, setDraftToken] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [owner, setOwner] = useState("");

  useEffect(() => {
    setToken(storedToken());
    void fetch("/api/phone")
      .then(async (response) => {
        const body = (await response.json()) as PhoneStatus;
        if (!response.ok) throw new Error(body.error ?? "Couldn't read the phone.");
        return body;
      })
      .then((body) => {
        setStatus(body);
        setOwner(body.phone?.ownerNumber ?? "");
      })
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : "Couldn't read the phone.");
      });
  }, []);

  function apply(body: PhoneStatus): void {
    setStatus(body);
    setOwner(body.phone?.ownerNumber ?? "");
    announceFeatureChange();
  }

  function act(init: RequestInit, label: string): void {
    setBusy(label);
    setFailed(null);
    const headers = new Headers(init.headers);
    if (token.length > 0) headers.set("x-phone-admin-token", token);
    void fetch("/api/phone", { ...init, headers })
      .then(async (response) => {
        const body = (await response.json()) as PhoneStatus;
        if (!response.ok) throw new Error(body.error ?? `That didn't work (HTTP ${response.status}).`);
        return body;
      })
      .then(apply)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Request failed.";
        // A rejected token is worse than none: it silently fails every action
        // until cleared, so drop it and let the unlock form return.
        if (/admin token/i.test(message)) {
          window.sessionStorage.removeItem(TOKEN_KEY);
          setToken("");
        }
        setFailed(message);
      })
      .finally(() => setBusy(null));
  }

  const post = (payload: Record<string, unknown>, label: string) =>
    act(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      label,
    );

  if (status === null && failed === null) {
    return (
      <div className="flex justify-center py-8">
        <Loader size={18} />
      </div>
    );
  }

  const phone = status?.phone ?? null;
  const provisioned = phone?.phoneNumber != null;
  const campaign = status?.registration?.campaign_status ?? null;

  return (
    <div className="flex flex-col gap-4">
      {failed !== null && (
        <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-sm text-kumo-danger">
          {failed}
        </p>
      )}

      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-recessed">
          <PhoneIcon className="size-4 text-kumo-subtle" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Phone</p>
            <Badge variant={provisioned ? "success" : "secondary"}>
              {provisioned ? (phone?.phoneNumber ?? "active") : "no number"}
            </Badge>
            {status?.keySource === "env" && <Badge variant="secondary">env key</Badge>}
          </div>
          <p className="mt-1 text-xs text-kumo-subtle">
            A number of {AGENT_NAME}&rsquo;s own: she can text and iMessage people, make and take
            calls, and read verification codes sent to it. $3 a month, plus $0.02 a text and $0.13 a
            minute of call.
          </p>
        </div>
      </div>

      {status?.authRequired === true && token.length === 0 ? (
        <TokenForm
          configured={status.authConfigured === true}
          draft={draftToken}
          onDraft={setDraftToken}
          onUnlock={() => {
            window.sessionStorage.setItem(TOKEN_KEY, draftToken.trim());
            setToken(draftToken.trim());
            setDraftToken("");
            setFailed(null);
          }}
        />
      ) : status?.enabled !== true ? (
        <KeyForm
          canStore={status?.hasDatabase ?? false}
          draft={draftKey}
          busy={busy === "key"}
          onDraft={setDraftKey}
          onSave={() => {
            act(
              {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ apiKey: draftKey.trim() }),
              },
              "key",
            );
            setDraftKey("");
          }}
        />
      ) : (
        <>
          {!provisioned ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-kumo-subtle">
                Pick up a number to switch the phone on. Area code is best-effort — if it&rsquo;s
                unavailable you get another one in the US.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  size="sm"
                  value={areaCode}
                  placeholder="Area code (optional)"
                  aria-label="Preferred area code"
                  className="w-44"
                  onChange={(event) => setAreaCode(event.target.value)}
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => post({ action: "provision", areaCode }, "provision")}
                >
                  {busy === "provision" ? <Loader size={14} /> : "Get a number"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <p className="text-xs text-kumo-subtle">
                  Your own number. Texts and calls from it are treated as {OWNER_NAME}&rsquo;s;
                  everyone else reaches {AGENT_NAME} as a guest and can&rsquo;t use her private
                  tools.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    size="sm"
                    value={owner}
                    placeholder="+1 555 123 4567"
                    aria-label="Your phone number"
                    className="w-56"
                    onChange={(event) => setOwner(event.target.value)}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null || owner.trim() === (phone?.ownerNumber ?? "")}
                    onClick={() => post({ action: "owner", ownerNumber: owner }, "owner")}
                  >
                    {busy === "owner" ? <Loader size={14} /> : "Save"}
                  </Button>
                </div>
                {phone?.ownerNumber == null && (
                  <p className="text-xs text-kumo-danger">
                    Until this is set, nobody counts as the owner and {AGENT_NAME} will ignore every
                    incoming text.
                  </p>
                )}
              </div>

              {campaign !== null && campaign !== "approved" && (
                <p className="rounded-lg border border-kumo-hairline bg-kumo-tint px-3 py-2 text-xs text-kumo-subtle">
                  Texting US numbers over SMS needs carrier registration (10DLC), currently{" "}
                  <span className="font-medium">{campaign}</span>. Review takes about 7&ndash;10
                  business days. iMessage and calls work now and need none of it.
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => post({ action: "release" }, "release")}
                >
                  {busy === "release" ? <Loader size={14} /> : "Release number"}
                </Button>
                {phone?.webhookRegistered !== true && (
                  <span className="text-xs text-kumo-danger">
                    No webhook is registered, so nothing will reach her. Release and try again.
                  </span>
                )}
              </div>
            </div>
          )}

          {status.keySource === "app" && (
            <RemoveKeyRow
              hint={status.keyHint ?? null}
              busy={busy === "removeKey"}
              onRemove={() => act({ method: "DELETE" }, "removeKey")}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Unlocks the controls. Phone management buys numbers and rotates credentials,
 * so unlike the rest of the manage surface it will not act for an anonymous
 * visitor — the deployment sets AGENTPHONE_ADMIN_TOKEN and it is entered here.
 */
function TokenForm({
  configured,
  draft,
  onDraft,
  onUnlock,
}: {
  configured: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onUnlock: () => void;
}) {
  if (!configured) {
    return (
      <p className="text-xs text-kumo-subtle">
        Phone management is locked. Set <code className="font-mono">AGENTPHONE_ADMIN_TOKEN</code> on
        this deployment and reload, then enter it here. Buying a number and rotating the API key
        cost real money, so they are not left open to anyone who can load this page.
      </p>
    );
  }

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim().length > 0) onUnlock();
      }}
    >
      <p className="text-sm text-kumo-subtle">
        Enter the admin token for this deployment to manage the phone. It is kept for this tab only.
      </p>
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          type="password"
          value={draft}
          placeholder="admin token"
          aria-label="Phone admin token"
          className="flex-1"
          onChange={(event) => onDraft(event.target.value)}
        />
        <Button type="submit" variant="primary" size="sm" disabled={draft.trim().length === 0}>
          Unlock
        </Button>
      </div>
    </form>
  );
}

/**
 * First-run setup: paste a key here instead of touching deployment env vars.
 * It is never sent back to the browser afterwards — only the last four
 * characters, so you can tell which key is in use.
 */
function KeyForm({
  canStore,
  draft,
  busy,
  onDraft,
  onSave,
}: {
  canStore: boolean;
  draft: string;
  busy: boolean;
  onDraft: (value: string) => void;
  onSave: () => void;
}) {
  if (!canStore) {
    return (
      <p className="text-xs text-kumo-subtle">
        Storing a key in the app needs a database. Set <code className="font-mono">DATABASE_URL</code>{" "}
        and reload, or set <code className="font-mono">AGENTPHONE_API_KEY</code> in the environment.
      </p>
    );
  }

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim().length > 0 && !busy) onSave();
      }}
    >
      <p className="text-sm text-kumo-subtle">
        Give {AGENT_NAME} a phone: paste an{" "}
        <a
          href="https://agentphone.ai"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          AgentPhone API key
        </a>{" "}
        and it is stored in this app — no deployment settings involved. New accounts start with $5
        of credit.
      </p>
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          type="password"
          value={draft}
          placeholder="sk_live_..."
          aria-label="AgentPhone API key"
          className="flex-1"
          onChange={(event) => onDraft(event.target.value)}
        />
        <Button type="submit" variant="primary" size="sm" disabled={busy || draft.trim().length === 0}>
          {busy ? <Loader size={14} /> : "Save"}
        </Button>
      </div>
    </form>
  );
}

/** Clearing the app-stored key turns the whole capability off; ask twice. */
function RemoveKeyRow({
  hint,
  busy,
  onRemove,
}: {
  hint: string | null;
  busy: boolean;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <p className="text-xs text-kumo-subtle">
      The AgentPhone key {hint === null ? "is stored in this app" : `(${hint}) is stored in this app`}.{" "}
      {confirming ? (
        <>
          Removing it turns off {AGENT_NAME}&rsquo;s phone. The number itself keeps billing until you
          release it.{" "}
          <button
            type="button"
            className="text-kumo-danger underline"
            disabled={busy}
            onClick={onRemove}
          >
            Remove it
          </button>{" "}
          <button type="button" className="underline" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </>
      ) : (
        <button type="button" className="underline" onClick={() => setConfirming(true)}>
          Remove key
        </button>
      )}
    </p>
  );
}
