"use client";

import { useEffect, useMemo, useState } from "react";

type InteractionState = {
  title?: string;
  description?: string;
  options?: readonly { id: string; label: string; detail?: string }[];
  progress?: number;
  status?: string;
  allowFreeform?: boolean;
};

type Interaction = {
  interactionId: string;
  kind: string;
  stateVersion: number;
  status: string;
  sensitive: boolean;
  state: InteractionState;
  expiresAt: string;
};

export function InteractionCard(props: {
  readonly interactionId: string;
  readonly token: string;
}): React.ReactNode {
  const [token, setToken] = useState(props.token);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ownerAuthorization, setOwnerAuthorization] = useState("");
  const [freeform, setFreeform] = useState("");
  const endpoint = useMemo(
    () =>
      `/api/imessage/interactions/${encodeURIComponent(props.interactionId)}`,
    [props.interactionId],
  );

  useEffect(() => {
    const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
    const capability = props.token || fragmentToken || "";
    setToken(capability);
    if (capability.length === 0) {
      setError("This interaction link is missing its capability.");
      return;
    }
    void fetch(endpoint, {
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { authorization: `Bearer ${capability}` },
    })
      .then(async (response) => {
        const body = (await response.json()) as Interaction | { error?: string };
        if (!response.ok) throw new Error("error" in body ? body.error : "Unable to load");
        setInteraction(body as Interaction);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Unable to load"),
      );
  }, [endpoint, props.token]);

  async function submit(result: Record<string, unknown>): Promise<void> {
    if (interaction === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...(interaction.sensitive && ownerAuthorization.length > 0
            ? { "x-ruth-owner-authorization": ownerAuthorization }
            : {}),
        },
        body: JSON.stringify({
          stateVersion: interaction.stateVersion,
          result,
        }),
        referrerPolicy: "no-referrer",
      });
      const body = (await response.json()) as { error?: string; status?: string };
      if (!response.ok) throw new Error(body.error ?? "Action was not accepted");
      setInteraction({ ...interaction, status: body.status ?? "selected" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (error !== null && interaction === null) {
    return <main className="card"><p className="eyebrow">Ruth</p><h1>Unavailable</h1><p>{error}</p></main>;
  }
  if (interaction === null) {
    return <main className="card"><p className="eyebrow">Ruth</p><h1>Loading…</h1></main>;
  }

  const state = interaction.state ?? {};
  const completed = interaction.status === "completed";
  const selected = interaction.status === "selected";
  return (
    <main className="card">
      <p className="eyebrow">Ruth · {interaction.kind.replaceAll("_", " ")}</p>
      <h1>{state.title ?? (completed ? "Done" : selected ? "Working…" : "Choose an action")}</h1>
      {state.description ? <p className="description">{state.description}</p> : null}
      {typeof state.progress === "number" ? (
        <div className="progress" aria-label={`${Math.round(state.progress)} percent complete`}>
          <span style={{ width: `${Math.max(0, Math.min(100, state.progress))}%` }} />
        </div>
      ) : null}
      {completed ? (
        <p className="complete">This interaction has been completed.</p>
      ) : selected ? (
        <p className="complete">Your choice is saved. Ruth is resuming this conversation.</p>
      ) : (
        <>
          {interaction.sensitive ? (
            <label className="owner-auth">
              <span>Ruth owner authorization</span>
              <input
                type="password"
                value={ownerAuthorization}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setOwnerAuthorization(event.target.value)}
                placeholder="Enter the separate owner secret"
              />
            </label>
          ) : null}
          <div className="actions">
            {(state.options ?? [
              { id: "approve", label: "Approve" },
              { id: "deny", label: "Decline" },
            ]).map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={
                  submitting ||
                  (interaction.sensitive && ownerAuthorization.length < 32)
                }
                onClick={() => void submit({ optionId: option.id })}
              >
                <span>{option.label}</span>
                {option.detail ? <small>{option.detail}</small> : null}
              </button>
            ))}
            {state.allowFreeform ? (
              <>
                <label className="owner-auth">
                  <span>Your response</span>
                  <input
                    type="text"
                    value={freeform}
                    onChange={(event) => setFreeform(event.target.value)}
                    placeholder="Type a response"
                  />
                </label>
                <button
                  type="button"
                  disabled={submitting || freeform.trim().length === 0}
                  onClick={() => void submit({ value: freeform.trim() })}
                >
                  <span>Send response</span>
                </button>
              </>
            ) : null}
          </div>
        </>
      )}
      {interaction.sensitive && interaction.status === "pending" ? (
        <p className="sensitive">The capability link alone cannot authorize this action.</p>
      ) : null}
      {error !== null ? <p className="error" role="alert">{error}</p> : null}
    </main>
  );
}
