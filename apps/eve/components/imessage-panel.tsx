"use client";

import {
  Badge,
  Button,
  Input,
  LinkButton,
  Loader,
  Select,
  Switch,
} from "@cloudflare/kumo";
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
  featureFlags: Record<string, boolean>;
  richExperienceEnabled: boolean;
  voiceReplyMode: "mirror" | "text" | "always";
  operations: {
    highLevelConfigured: boolean;
    advanced: {
      configured: boolean;
      authenticated: boolean;
      iMessageAvailable?: boolean;
      focusSilenced?: boolean;
      reason?: string;
    };
    inbox: {
      queued: number;
      processing: number;
      retry: number;
      dead: number;
    };
    eventPumps: readonly {
      phone: string;
      eventStream: string;
      lastContiguousSequence: number;
      leaseActive: boolean;
      lastCatchupResult: string | null;
      updatedAt: string;
    }[];
    deadLetters: readonly {
      id: string;
      source: string;
      conversationRef: string;
      attempts: number;
      errorCode: string | null;
      receivedAt: string;
    }[];
    lines: readonly {
      phoneRef: string;
      allocationState: string;
      dailyMessages: number;
      dailyNewConversations: number;
      messageCapacity: number | null;
      newConversationCapacity: number | null;
      utilization: number | null;
      alert: boolean;
    }[];
    media: { pending: number; failed: number };
    interactions: { pending: number; completed: number };
    boundConversations: number;
    securityEvents: readonly {
      action: string;
      role: string;
      target: string;
      decision: string;
      at: string;
    }[];
    universalMiniApps: { ready: boolean };
    brandedExtension: { ready: boolean };
    locationWatches: readonly {
      watchId: string;
      expiresAt: string;
      hasSnapshot: boolean;
    }[];
    retention: {
      processedIngressHours: number;
      failedIngressDays: number;
      interactionExpiryHours: number;
      sensitiveInteractionExpiryMinutes: number;
      groupMemoryDays: number;
    };
    calls: { available: false; reason: string };
  } | null;
}

const FEATURE_LABELS: Record<string, { title: string; detail: string }> = {
  imessage_passive_rich_ingest: {
    title: "Rich inbound events",
    detail: "Understand native media and state changes without automatically replying.",
  },
  imessage_durable_router: {
    title: "Durable delivery",
    detail: "Acknowledge quickly, preserve order, retry, and dead-letter failed events.",
  },
  imessage_native_markdown: {
    title: "Native formatting",
    detail: "Bold, italic, underline, strike, links, and animated text.",
  },
  imessage_rich_media: {
    title: "Rich media",
    detail: "Images, albums, documents, video, Live Photos, contacts, and previews.",
  },
  imessage_voice: {
    title: "Voice memos",
    detail: "Transcription plus native spoken Ruth replies.",
  },
  imessage_streaming_edits: {
    title: "Evolving reply bubble",
    detail: "Build one answer in place using native edits.",
  },
  imessage_replies_reactions: {
    title: "Replies and reactions",
    detail: "Threads, tapbacks, emoji reactions, edits, and unsend.",
  },
  imessage_polls: {
    title: "Native polls",
    detail: "Conversation decisions with durable vote handling.",
  },
  imessage_universal_apps: {
    title: "Interactive cards",
    detail: "Approvals, forms, schedules, previews, and progress in Messages.",
  },
  imessage_branded_extension: {
    title: "Ruth Messages extension",
    detail: "Prefer the installed branded SwiftUI renderer.",
  },
  imessage_group_admin: {
    title: "Group administration",
    detail: "Create, rename, manage members and avatars with owner approval.",
  },
  imessage_advanced_kit: {
    title: "Photon Advanced Kit",
    detail: "Entitlement-gated history, events, formatting, stickers, Focus, and location.",
  },
  imessage_stickers: {
    title: "Stickers",
    detail: "Place native stickers with bounded position, scale, and rotation.",
  },
  imessage_focus_notify: {
    title: "Notify Anyway",
    detail: "One-shot Focus override only after explicit owner confirmation.",
  },
  imessage_location: {
    title: "Location requests",
    detail: "Visible, owner-only Find My requests with short-lived snapshots.",
  },
};

function formatWhen(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function fetchStatus(): Promise<IMessageStatus> {
  const response = await fetch("/api/imessage");
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<IMessageStatus>;
}

export function IMessagePanel() {
  const [status, setStatus] = useState<IMessageStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchStatus()
      .then((nextStatus) => {
        if (active) setStatus(nextStatus);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFailed(error instanceof Error ? error.message : "Couldn't read the iMessage state.");
      });
    return () => {
      active = false;
    };
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
        if (action === "feature" || action === "feature_bundle") {
          setStatus(await fetchStatus());
        }
        if (action === "voice_mode") {
          setStatus((prev) =>
            prev === null
              ? prev
              : {
                  ...prev,
                  voiceReplyMode: extra.mode as IMessageStatus["voiceReplyMode"],
                },
          );
        }
        if (action === "replay") {
          setStatus((prev) =>
            prev === null || prev.operations === null
              ? prev
              : {
                  ...prev,
                  operations: {
                    ...prev.operations,
                    deadLetters: prev.operations.deadLetters.filter(
                      (item) => item.id !== extra.id,
                    ),
                  },
                },
          );
        }
        if (action === "stop_location") {
          setStatus((prev) =>
            prev === null || prev.operations === null
              ? prev
              : {
                  ...prev,
                  operations: {
                    ...prev.operations,
                    locationWatches: prev.operations.locationWatches.filter(
                      (item) => item.watchId !== extra.id,
                    ),
                  },
                },
          );
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
        shared line. DMs work only from the number paired here. Group chats work too: add{" "}
        {AGENT_NAME}&rsquo;s number to a group and send the first message yourself — that unlocks
        the group, and then everyone in it can talk to {AGENT_NAME}. Sensitive requests still
        need your go-ahead.
      </p>

      {paired && status !== null && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Spectrum SDK</p>
                <Badge variant={status.operations?.highLevelConfigured ? "success" : "secondary"}>
                  {status.operations?.highLevelConfigured ? "ready" : "router unavailable"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-kumo-subtle">
                Common native messages, media, polls, effects, and universal apps.
              </p>
            </div>
            <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Advanced Kit</p>
                <Badge
                  variant={
                    status.operations?.advanced.authenticated ? "success" : "secondary"
                  }
                >
                  {status.operations?.advanced.authenticated
                    ? "connected"
                    : status.operations?.advanced.configured
                      ? "needs attention"
                      : "not configured"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-kumo-subtle">
                {status.operations?.advanced.reason ??
                  "Credential and address probe succeeded. Individual capabilities remain feature- and entitlement-gated until device validation."}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
            <p className="text-sm font-medium">Delivery health</p>
            <div className="mt-2 grid grid-cols-4 gap-2 text-center">
              {(["queued", "processing", "retry", "dead"] as const).map((key) => (
                <div key={key} className="rounded-md bg-kumo-recessed px-2 py-2">
                  <p className="text-base font-semibold">
                    {status.operations?.inbox[key] ?? 0}
                  </p>
                  <p className="text-[11px] capitalize text-kumo-subtle">{key}</p>
                </div>
              ))}
            </div>
            {(status.operations?.eventPumps ?? []).map((pump) => (
              <div key={`${pump.phone}:${pump.eventStream}`} className="mt-2 text-xs text-kumo-subtle">
                Event pump {pump.leaseActive ? "live" : "idle"} · sequence{" "}
                {pump.lastContiguousSequence.toLocaleString()}
                {pump.lastCatchupResult !== null ? ` · ${pump.lastCatchupResult}` : ""}
              </div>
            ))}
            <p className="mt-2 text-xs text-kumo-subtle">
              {status.operations?.boundConversations ?? 0} bound conversations ·{" "}
              {status.operations?.media.pending ?? 0} media processing ·{" "}
              {status.operations?.interactions.pending ?? 0} active interactions
            </p>
          </div>

          {(status.operations?.lines.length ?? 0) > 0 && (
            <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
              <p className="text-sm font-medium">Line allocation</p>
              <div className="mt-3 flex flex-col gap-2">
                {status.operations?.lines.map((line) => (
                  <div
                    key={line.phoneRef}
                    className="flex items-center justify-between gap-3 rounded-md bg-kumo-recessed px-3 py-2"
                  >
                    <div>
                      <p className="font-mono text-xs">line {line.phoneRef}</p>
                      <p className="mt-0.5 text-xs text-kumo-subtle">
                        {line.dailyMessages} messages · {line.dailyNewConversations} new
                        conversations
                      </p>
                    </div>
                    <Badge variant={line.alert ? "secondary" : "success"}>
                      {line.utilization === null
                        ? line.allocationState
                        : `${Math.round(line.utilization * 100)}%`}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Universal Mini App</p>
                <Badge
                  variant={status.operations?.universalMiniApps.ready ? "success" : "secondary"}
                >
                  {status.operations?.universalMiniApps.ready ? "ready" : "needs public URL"}
                </Badge>
              </div>
            </div>
            <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Ruth extension</p>
                <Badge
                  variant={status.operations?.brandedExtension.ready ? "success" : "secondary"}
                >
                  {status.operations?.brandedExtension.ready ? "configured" : "not configured"}
                </Badge>
              </div>
            </div>
          </div>

          <Select<IMessageStatus["voiceReplyMode"]>
            label="Voice memo replies"
            size="sm"
            className="max-w-sm"
            value={status.voiceReplyMode}
            disabled={busy !== null}
            renderValue={(value) =>
              value === "mirror"
                ? "Mirror the sender"
                : value === "text"
                  ? "Text only"
                  : "Always voice"
            }
            description="Mirror is the default: voice receives voice, ordinary text receives text."
            onValueChange={(value) => {
              if (value !== null) act("voice_mode", { mode: value });
            }}
          >
            <Select.Option value="mirror">Mirror the sender</Select.Option>
            <Select.Option value="text">Text only</Select.Option>
            <Select.Option value="always">Always voice</Select.Option>
          </Select>

          {(status.operations?.locationWatches.length ?? 0) > 0 && (
            <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
              <p className="text-sm font-medium">Active location sharing</p>
              <p className="mt-1 text-xs text-kumo-subtle">
                Ruth keeps only the latest encrypted snapshot and removes it when sharing stops.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {status.operations?.locationWatches.map((watch) => (
                  <div
                    key={watch.watchId}
                    className="flex items-center justify-between gap-3 rounded-md bg-kumo-recessed px-3 py-2"
                  >
                    <p className="text-xs text-kumo-subtle">
                      {watch.hasSnapshot ? "Location available" : "Waiting for location"} · stops{" "}
                      {new Date(watch.expiresAt).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        act(
                          "stop_location",
                          { id: watch.watchId },
                          "Location sharing stopped and the latest snapshot was deleted.",
                        )
                      }
                    >
                      Stop
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-kumo-hairline bg-kumo-tint p-3">
            <Switch
              checked={status.richExperienceEnabled === true}
              disabled={busy !== null}
              onCheckedChange={(enabled) =>
                act(
                  "feature_bundle",
                  { enabled: String(enabled) },
                  enabled
                    ? "Rich iMessage features enabled. Advanced and sensitive controls remain separate."
                    : "Rich iMessage features disabled. Durable delivery remains active.",
                )
              }
              controlFirst
              label={
                <span>
                  <span className="block text-sm font-medium">
                    Rich iMessage experience
                  </span>
                  <span className="mt-0.5 block text-xs font-normal text-kumo-subtle">
                    One switch for native formatting, media, voice, evolving replies,
                    reactions, polls, and interactive cards.
                  </span>
                </span>
              }
            />
          </div>

          <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
            <p className="mb-3 text-sm font-medium">Capabilities and kill switches</p>
            <div className="flex flex-col gap-3">
              {Object.entries(FEATURE_LABELS).map(([flag, copy]) => (
                <Switch
                  key={flag}
                  checked={status.featureFlags[flag] === true}
                  disabled={busy !== null}
                  onCheckedChange={(enabled) =>
                    act("feature", { flag, enabled: String(enabled) })
                  }
                  controlFirst
                  label={
                    <span>
                      <span className="block text-sm font-medium">{copy.title}</span>
                      <span className="mt-0.5 block text-xs font-normal text-kumo-subtle">
                        {copy.detail}
                      </span>
                    </span>
                  }
                />
              ))}
            </div>
          </div>

          {(status.operations?.deadLetters.length ?? 0) > 0 && (
            <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
              <p className="text-sm font-medium">Dead-letter replay</p>
              <p className="mt-1 text-xs text-kumo-subtle">
                Redacted metadata only. Message bodies remain hidden.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {status.operations?.deadLetters.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate font-mono text-xs text-kumo-subtle">
                      {item.source} · {item.conversationRef} · {item.errorCode ?? "failed"}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => act("replay", { id: item.id }, "Event queued for replay.")}
                    >
                      Replay
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
            <p className="text-sm font-medium">Privacy and retention</p>
            <p className="mt-1 text-xs text-kumo-subtle">
              Processed ingress is removed after{" "}
              {status.operations?.retention.processedIngressHours ?? 24} hours; failed events
              after {status.operations?.retention.failedIngressDays ?? 7} days. Sensitive
              approvals expire in{" "}
              {status.operations?.retention.sensitiveInteractionExpiryMinutes ?? 10} minutes.
              Public group memory expires after{" "}
              {status.operations?.retention.groupMemoryDays ?? 30} days.
            </p>
            {(status.operations?.securityEvents.length ?? 0) > 0 && (
              <div className="mt-3 flex flex-col gap-1">
                {status.operations?.securityEvents.slice(0, 5).map((event, index) => (
                  <p
                    key={`${event.at}:${event.action}:${index}`}
                    className="font-mono text-[11px] text-kumo-subtle"
                  >
                    {event.decision} · {event.role} · {event.target} · {event.action}
                  </p>
                ))}
              </div>
            )}
          </div>

          <p className="text-xs text-kumo-subtle">
            Live calls unavailable — awaiting Photon&rsquo;s documented call-control SDK.
          </p>
        </>
      )}

      {status?.hasDatabase === true ? (
        <LinkButton href="/imessage" variant="secondary" size="sm">
          Open conversation log
        </LinkButton>
      ) : null}
    </div>
  );
}
