"use client";

import { Badge, Button, Input, InputArea, Loader, Radio } from "@cloudflare/kumo";
import { HashIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { AGENT_NAME } from "@/lib/identity";

// Manage -> Slack: setup status plus the emoji-reaction rules.
//
// There are no built-in emoji behaviors — reacting does nothing until a rule
// exists here. The starter chips below only fill the form; nothing takes
// effect until the owner saves.

type Audience = "owner" | "anyone";

interface ReactionRule {
  emoji: string;
  prompt: string;
  audience: Audience;
}

interface SlackStatus {
  hasDatabase: boolean;
  configured: boolean;
  ownerConfigured: boolean;
  linked: boolean;
  rules: ReactionRule[];
}

/** One-click starting points. These fill the form; they are not defaults. */
const STARTERS: readonly ReactionRule[] = [
  { emoji: "eyes", prompt: "Read this message and reply in its thread.", audience: "owner" },
  { emoji: "alarm_clock", prompt: "Turn this message into a reminder.", audience: "owner" },
  { emoji: "bookmark", prompt: "Remember this message.", audience: "owner" },
  {
    emoji: "white_check_mark",
    prompt:
      "Treat this as done: cancel the related reminder if you made one, and stay quiet otherwise.",
    audience: "owner",
  },
];

const AUDIENCE_LABELS: Record<Audience, string> = {
  owner: "Only me",
  anyone: "Anyone",
};

export function SlackPanel() {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [rules, setRules] = useState<ReactionRule[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/slack")
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<SlackStatus>;
      })
      .then((value) => {
        setStatus(value);
        setRules(value.rules);
      })
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : "Couldn't read the Slack state.");
      });
  }, []);

  function save(next: ReactionRule[]) {
    setSaving(true);
    setFailed(null);
    setNotice(null);
    void fetch("/api/slack", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: next }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { rules?: ReactionRule[]; error?: string }
          | null;
        if (!response.ok) {
          throw new Error(body?.error ?? `That didn't work (HTTP ${response.status}).`);
        }
        // The server normalizes emoji names, so adopt what it stored rather
        // than the draft — otherwise ":Eyes:" stays in the box after saving.
        if (body?.rules !== undefined) setRules(body.rules);
        setNotice(next.length === 0 ? "All reaction rules removed." : "Reaction rules saved.");
      })
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : "Request failed.");
      })
      .finally(() => setSaving(false));
  }

  function update(index: number, patch: Partial<ReactionRule>) {
    setRules((prev) => prev.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
  }

  if (status === null && failed === null) {
    return (
      <div className="flex justify-center py-8">
        <Loader size={18} />
      </div>
    );
  }

  const ready = status?.configured === true && status.ownerConfigured;
  const editable = status?.hasDatabase === true;
  const unused = STARTERS.filter((starter) => !rules.some((rule) => rule.emoji === starter.emoji));

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
          <HashIcon className="size-4 text-kumo-subtle" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Slack</p>
            <Badge variant={ready ? "success" : "secondary"}>
              {status?.configured !== true
                ? "not configured"
                : !status.ownerConfigured
                  ? "no owner set"
                  : status.linked
                    ? "linked"
                    : "ready"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-kumo-subtle">
            Mention {AGENT_NAME} in a channel or send her a DM. She keeps replying in a thread
            she is already in without being mentioned again, and <code className="font-mono">/new</code>{" "}
            starts the conversation over. Everyone who is not you reaches her as a guest: she
            will help, but anything sensitive waits for you.
          </p>
        </div>
      </div>

      {status?.configured !== true && (
        <p className="text-xs text-kumo-subtle">
          No Slack credentials. Point{" "}
          <code className="font-mono">SLACK_CONNECT_CLIENT_ID</code> at a Vercel Connect client
          whose trigger is attached to <code className="font-mono">/eve/v1/slack</code>.
        </p>
      )}
      {status?.configured === true && !status.ownerConfigured && (
        <p className="text-xs text-kumo-subtle">
          No owner is set, so everyone in the workspace is treated as a guest and owner-only
          reaction rules never fire. Set{" "}
          <code className="font-mono">SLACK_OWNER_USER_ID</code> to your Slack user id.
        </p>
      )}
      {status?.configured === true && status.ownerConfigured && !status.linked && (
        <p className="text-xs text-kumo-subtle">
          DM {AGENT_NAME} in Slack once and she will remember where to reach you, which is what
          lets reminders and triggers deliver here.
        </p>
      )}

      <div className="flex flex-col gap-3 border-t border-kumo-hairline pt-4">
        <div>
          <p className="text-sm font-medium">Reaction triggers</p>
          <p className="mt-1 text-xs text-kumo-subtle">
            React to any message with an emoji you list here and {AGENT_NAME} acts on it — even
            in threads she was never mentioned in. Nothing is set up by default.
          </p>
        </div>

        {!editable ? (
          <p className="text-xs text-kumo-subtle">
            Reaction rules need a database to store them. Set{" "}
            <code className="font-mono">DATABASE_URL</code> and reload.
          </p>
        ) : (
          <>
            {rules.length === 0 && (
              <p className="text-xs text-kumo-subtle">
                No reaction rules yet, so reacting does nothing.
              </p>
            )}

            {/* Keyed by index because a draft rule has no stable id — the
                emoji is the natural key but is editable and blank on a new
                row. Safe here: every field is fully controlled from `rules`,
                so a reused row renders the values it is given. */}
            {rules.map((rule, index) => (
              <div
                key={index}
                className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    size="sm"
                    value={rule.emoji}
                    aria-label="Emoji name"
                    placeholder="eyes"
                    className="w-44 font-mono"
                    onChange={(event) => update(index, { emoji: event.target.value })}
                  />
                  <Radio.Group<Audience>
                    orientation="horizontal"
                    value={rule.audience}
                    onValueChange={(value) => update(index, { audience: value })}
                  >
                    <Radio.Legend className="sr-only">Who can trigger this</Radio.Legend>
                    {(Object.entries(AUDIENCE_LABELS) as [Audience, string][]).map(
                      ([value, label]) => (
                        <Radio.Item<Audience>
                          key={value}
                          label={label}
                          value={value}
                          className="[&>span]:text-sm [&>[data-kumo-part=item]]:mt-[3px] [&>[data-kumo-part=item]]:size-3.5 [&>[data-kumo-part=item]_span]:size-1.5"
                        />
                      ),
                    )}
                  </Radio.Group>
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    icon={TrashIcon}
                    aria-label="Remove this rule"
                    disabled={saving}
                    onClick={() => setRules((prev) => prev.filter((_, at) => at !== index))}
                  />
                </div>
                <InputArea
                  value={rule.prompt}
                  aria-label="What to do"
                  autoResize
                  minRows={2}
                  maxRows={8}
                  className="text-xs"
                  onChange={(event) => update(index, { prompt: event.target.value })}
                />
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={PlusIcon}
                disabled={saving}
                onClick={() =>
                  setRules((prev) => [...prev, { emoji: "", prompt: "", audience: "owner" }])
                }
              >
                Add a rule
              </Button>
              <Button variant="primary" size="sm" disabled={saving} onClick={() => save(rules)}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>

            {unused.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-kumo-subtle">Start from an example</span>
                <div className="flex flex-wrap items-center gap-2">
                  {unused.map((starter) => (
                    <Button
                      key={starter.emoji}
                      variant="secondary"
                      size="sm"
                      disabled={saving}
                      onClick={() => setRules((prev) => [...prev, { ...starter }])}
                    >
                      <span className="font-mono">:{starter.emoji}:</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
