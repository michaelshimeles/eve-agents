import { defineState } from "eve/context";
import { defineHook, type HookContext } from "eve/hooks";
import type { RaindropProperties } from "raindrop-ai";

import {
  RAINDROP_EVENT_NAME,
  RECORD_IO,
  raindrop,
  raindropEventId,
  raindropUserId,
} from "../instrumentation";

function eventId(ctx: HookContext, turnId: string): string {
  return raindropEventId(ctx.session.id, turnId);
}

function baseProperties(ctx: HookContext, status: string): RaindropProperties {
  return {
    agent_name: ctx.agent.name,
    channel: ctx.channel.kind ?? "unknown",
    record_io: RECORD_IO,
    status,
    turn_sequence: ctx.session.turn.sequence,
  };
}

interface Usage extends RaindropProperties {
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly cost_usd: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

interface TurnState {
  readonly input?: string;
  readonly inputAttachmentCount: number;
  readonly latestOutputStep?: number;
  readonly latestStepIndex?: number;
  readonly output?: string;
  readonly startedAt: string;
  readonly usageByStep: Record<string, Usage>;
}

type TurnStates = Readonly<Record<string, TurnState>>;

const turnStates = defineState<TurnStates>("ruth.raindrop-turns", () => ({}));
const TERMINAL_EXPORT_RETRY_DELAYS_MS = [250, 1_000] as const;

function emptyTurn(at: string): TurnState {
  return {
    inputAttachmentCount: 0,
    startedAt: at,
    usageByStep: {},
  };
}

function updateTurn(
  turnId: string,
  at: string,
  update: (current: TurnState) => TurnState,
): void {
  turnStates.update((turns) => ({
    ...turns,
    [turnId]: update(turns[turnId] ?? emptyTurn(at)),
  }));
}

function removeTurn(turnId: string): void {
  turnStates.update((turns) => {
    const next = { ...turns };
    delete next[turnId];
    return next;
  });
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function observe(name: string, run: () => Promise<void> | void): Promise<boolean> {
  if (raindrop === null) return false;
  try {
    await raindrop.asCurrent(run);
    return true;
  } catch (error) {
    // A monitoring outage must not turn a successful durable turn into a
    // failure, because Eve propagates errors thrown by hooks.
    console.warn(
      `[raindrop] ${name} failed`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Publish a running event for live visibility. No terminal field depends on
 * this partial: finishTurn sends one complete snapshot from Eve's durable
 * session state, so a process restart or replace-style Raindrop merge is safe.
 */
async function beginTurn(
  ctx: HookContext,
  turnId: string,
  startedAt: string,
  input: string | undefined,
  inputAttachmentCount: number,
): Promise<void> {
  const client = raindrop;
  if (client === null) return;

  await observe("begin turn", async () => {
    client.begin({
      eventId: eventId(ctx, turnId),
      event: RAINDROP_EVENT_NAME,
      userId: raindropUserId(ctx.session.id, ctx.session.auth),
      convoId: ctx.session.id,
      isPending: false,
      ...(input === undefined ? {} : { input }),
      ...(!RECORD_IO
        ? { output: "Content recording disabled by OTEL_RECORD_IO." }
        : {}),
      properties: {
        ...baseProperties(ctx, "running"),
        input_attachment_count: inputAttachmentCount,
        turn_started_at: startedAt,
      },
      timestamp: startedAt,
    });

    // begin() starts the immediate partial POST but does not return its promise.
    await client.forceFlush();
  });
}

function sumUsage(usageByStep: TurnState["usageByStep"]): Usage {
  return Object.values(usageByStep).reduce<Usage>(
    (total, usage) => ({
      cache_read_tokens: total.cache_read_tokens + usage.cache_read_tokens,
      cache_write_tokens: total.cache_write_tokens + usage.cache_write_tokens,
      cost_usd: total.cost_usd + usage.cost_usd,
      input_tokens: total.input_tokens + usage.input_tokens,
      output_tokens: total.output_tokens + usage.output_tokens,
    }),
    {
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
    },
  );
}

async function finishTurn(
  ctx: HookContext,
  turnId: string,
  status: "cancelled" | "completed" | "failed",
  finishedAt: string,
  terminalOutput?: string,
  extraProperties: Readonly<Record<string, string>> = {},
): Promise<void> {
  const client = raindrop;
  if (client === null) return;

  const state = turnStates.get()[turnId] ?? emptyTurn(finishedAt);
  const usage = sumUsage(state.usageByStep);
  const output = RECORD_IO
    ? (terminalOutput ??
      state.output ??
      `Turn ${status} without producing a text response.`)
    : "Content recording disabled by OTEL_RECORD_IO.";

  for (let attempt = 0; attempt <= TERMINAL_EXPORT_RETRY_DELAYS_MS.length; attempt += 1) {
    const exported = await observe(`finish ${status} turn`, async () => {
      const interaction = client.resumeInteraction(eventId(ctx, turnId));
      await interaction.finish({
        event: RAINDROP_EVENT_NAME,
        userId: raindropUserId(ctx.session.id, ctx.session.auth),
        convoId: ctx.session.id,
        output,
        ...(RECORD_IO && state.input !== undefined ? { input: state.input } : {}),
        properties: {
          ...baseProperties(ctx, status),
          ...extraProperties,
          ...usage,
          input_attachment_count: state.inputAttachmentCount,
          ...(state.latestOutputStep === undefined
            ? {}
            : { latest_output_step: state.latestOutputStep }),
          ...(state.latestStepIndex === undefined
            ? {}
            : { latest_step_index: state.latestStepIndex }),
          latency_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(state.startedAt)),
          turn_finished_at: finishedAt,
          turn_started_at: state.startedAt,
          usage_by_step: state.usageByStep,
        },
        timestamp: state.startedAt,
      });
    });

    if (exported) {
      removeTurn(turnId);
      return;
    }

    const retryDelay = TERMINAL_EXPORT_RETRY_DELAYS_MS[attempt];
    if (retryDelay !== undefined) await wait(retryDelay);
  }

  // Monitoring remains best-effort. The SDK already retries each request; this
  // outer event-level budget handles transient failures without failing the
  // successful Eve turn, then releases state instead of leaking it forever.
  console.warn(`[raindrop] terminal export exhausted retries for turn ${turnId}`);
  removeTurn(turnId);
}

export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      if (raindrop === null) return;

      const input = RECORD_IO && event.data.message.length > 0 ? event.data.message : undefined;
      const attachmentCount =
        event.data.parts?.filter((part) => part.type === "file").length ?? 0;
      const startedAt = event.meta?.at ?? new Date().toISOString();

      updateTurn(event.data.turnId, startedAt, (current) => ({
        ...current,
        ...(input === undefined ? {} : { input }),
        inputAttachmentCount: attachmentCount,
        startedAt,
      }));
      await beginTurn(ctx, event.data.turnId, startedAt, input, attachmentCount);
    },

    async "message.completed"(event) {
      if (raindrop === null) return;

      const message = event.data.message;
      if (message === null || message.length === 0) return;
      updateTurn(
        event.data.turnId,
        event.meta?.at ?? new Date().toISOString(),
        (current) => ({
          ...current,
          latestOutputStep: event.data.stepIndex,
          ...(RECORD_IO ? { output: message } : {}),
        }),
      );
    },

    async "result.completed"(event) {
      if (raindrop === null) return;

      updateTurn(
        event.data.turnId,
        event.meta?.at ?? new Date().toISOString(),
        (current) => ({
          ...current,
          latestOutputStep: event.data.stepIndex,
          ...(RECORD_IO ? { output: JSON.stringify(event.data.result) } : {}),
        }),
      );
    },

    async "step.completed"(event) {
      if (raindrop === null || event.data.usage === undefined) return;

      const usage = event.data.usage;
      updateTurn(
        event.data.turnId,
        event.meta?.at ?? new Date().toISOString(),
        (current) => ({
          ...current,
          latestStepIndex: event.data.stepIndex,
          usageByStep: {
            ...current.usageByStep,
            [String(event.data.stepIndex)]: {
              cache_read_tokens: usage.cacheReadTokens ?? 0,
              cache_write_tokens: usage.cacheWriteTokens ?? 0,
              cost_usd: usage.costUsd ?? 0,
              input_tokens: usage.inputTokens ?? 0,
              output_tokens: usage.outputTokens ?? 0,
            },
          },
        }),
      );
    },

    async "turn.completed"(event, ctx) {
      await finishTurn(
        ctx,
        event.data.turnId,
        "completed",
        event.meta?.at ?? new Date().toISOString(),
      );
    },

    async "turn.failed"(event, ctx) {
      await finishTurn(
        ctx,
        event.data.turnId,
        "failed",
        event.meta?.at ?? new Date().toISOString(),
        event.data.message,
        { error_code: event.data.code },
      );
    },

    async "turn.cancelled"(event, ctx) {
      await finishTurn(
        ctx,
        event.data.turnId,
        "cancelled",
        event.meta?.at ?? new Date().toISOString(),
      );
    },
  },
});
