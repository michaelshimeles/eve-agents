import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => ({
  begin: vi.fn(),
  finish: vi.fn(async (_snapshot: unknown) => undefined),
  forceFlush: vi.fn(async () => undefined),
  state: {} as Record<string, unknown>,
}));

vi.mock("eve/context", () => ({
  defineState: <T>(_name: string, initial: () => T) => ({
    get: () => {
      if (!("value" in telemetry.state)) telemetry.state.value = initial();
      return telemetry.state.value as T;
    },
    update: (update: (current: T) => T) => {
      if (!("value" in telemetry.state)) telemetry.state.value = initial();
      telemetry.state.value = update(telemetry.state.value as T);
    },
  }),
}));

vi.mock("../instrumentation", () => ({
  RAINDROP_EVENT_NAME: "ruth_agent_turn",
  RECORD_IO: true,
  raindrop: {
    asCurrent: <T>(run: () => T) => run(),
    begin: telemetry.begin,
    forceFlush: telemetry.forceFlush,
    resumeInteraction: vi.fn(() => ({ finish: telemetry.finish })),
  },
  raindropEventId: (sessionId: string, turnId: string) => `${sessionId}:${turnId}`,
  raindropUserId: (sessionId: string) => `user:${sessionId}`,
}));

const context = {
  agent: { name: "eve-agent" },
  channel: { kind: "http" },
  session: {
    auth: { current: null, initiator: null },
    id: "session-1",
    turn: { sequence: 0 },
  },
} as unknown as HookContext;

async function loadEvents() {
  const hook = (await import("../hooks/raindrop")).default;
  if (hook.events === undefined) throw new Error("Raindrop hook has no events");
  return hook.events;
}

describe("Raindrop durable turn hook", () => {
  beforeEach(() => {
    telemetry.begin.mockClear();
    telemetry.finish.mockReset();
    telemetry.finish.mockResolvedValue(undefined);
    telemetry.forceFlush.mockClear();
    telemetry.state = {};
  });

  it("finishes with a complete durable snapshot after a process restart", async () => {
    const initialEvents = await loadEvents();
    await initialEvents["message.received"]?.(
      {
        data: {
          message: "Keep this input",
          parts: [{ text: "Keep this input", type: "text" }],
          sequence: 0,
          turnId: "turn_0",
        },
        meta: { at: "2026-07-29T15:00:00.000Z" },
        type: "message.received",
      },
      context,
    );

    // Eve may resume the durable workflow in a fresh process between any two
    // stream events. Reloading the hook reproduces that boundary.
    vi.resetModules();
    const resumedEvents = await loadEvents();

    await resumedEvents["message.completed"]?.(
      {
        data: {
          finishReason: "stop",
          message: "Keep this output",
          sequence: 0,
          stepIndex: 1,
          turnId: "turn_0",
        },
        meta: { at: "2026-07-29T15:00:02.000Z" },
        type: "message.completed",
      },
      context,
    );
    await resumedEvents["step.completed"]?.(
      {
        data: {
          finishReason: "stop",
          sequence: 0,
          stepIndex: 1,
          turnId: "turn_0",
          usage: {
            cacheReadTokens: 13,
            cacheWriteTokens: 17,
            costUsd: 0.42,
            inputTokens: 23,
            outputTokens: 29,
          },
        },
        meta: { at: "2026-07-29T15:00:02.500Z" },
        type: "step.completed",
      },
      context,
    );
    await resumedEvents["step.completed"]?.(
      {
        data: {
          finishReason: "stop",
          sequence: 0,
          stepIndex: 2,
          turnId: "turn_0",
          usage: {
            cacheReadTokens: 2,
            cacheWriteTokens: 3,
            costUsd: 0.08,
            inputTokens: 5,
            outputTokens: 7,
          },
        },
        meta: { at: "2026-07-29T15:00:02.750Z" },
        type: "step.completed",
      },
      context,
    );
    await resumedEvents["turn.completed"]?.(
      {
        data: { sequence: 0, turnId: "turn_0" },
        meta: { at: "2026-07-29T15:00:03.000Z" },
        type: "turn.completed",
      },
      context,
    );

    expect(telemetry.begin).toHaveBeenCalledTimes(1);
    expect(telemetry.forceFlush).toHaveBeenCalledTimes(1);
    expect(telemetry.begin).toHaveBeenCalledWith({
      convoId: "session-1",
      event: "ruth_agent_turn",
      eventId: "session-1:turn_0",
      input: "Keep this input",
      isPending: false,
      properties: {
        agent_name: "eve-agent",
        channel: "http",
        input_attachment_count: 0,
        record_io: true,
        status: "running",
        turn_sequence: 0,
        turn_started_at: "2026-07-29T15:00:00.000Z",
      },
      timestamp: "2026-07-29T15:00:00.000Z",
      userId: "user:session-1",
    });

    expect(telemetry.finish).toHaveBeenCalledTimes(1);
    expect(telemetry.finish).toHaveBeenCalledWith({
      convoId: "session-1",
      event: "ruth_agent_turn",
      input: "Keep this input",
      output: "Keep this output",
      properties: {
        agent_name: "eve-agent",
        cache_read_tokens: 15,
        cache_write_tokens: 20,
        channel: "http",
        cost_usd: 0.5,
        input_attachment_count: 0,
        input_tokens: 28,
        latency_ms: 3000,
        latest_output_step: 1,
        latest_step_index: 2,
        output_tokens: 36,
        record_io: true,
        status: "completed",
        turn_finished_at: "2026-07-29T15:00:03.000Z",
        turn_sequence: 0,
        turn_started_at: "2026-07-29T15:00:00.000Z",
        usage_by_step: {
          "1": {
            cache_read_tokens: 13,
            cache_write_tokens: 17,
            cost_usd: 0.42,
            input_tokens: 23,
            output_tokens: 29,
          },
          "2": {
            cache_read_tokens: 2,
            cache_write_tokens: 3,
            cost_usd: 0.08,
            input_tokens: 5,
            output_tokens: 7,
          },
        },
      },
      timestamp: "2026-07-29T15:00:00.000Z",
      userId: "user:session-1",
    });

    expect(telemetry.state.value).toEqual({});
  });

  it("automatically retries a complete terminal snapshot after an export failure", async () => {
    const events = await loadEvents();
    await events["message.received"]?.(
      {
        data: {
          message: "Retry this input",
          parts: [{ text: "Retry this input", type: "text" }],
          sequence: 0,
          turnId: "turn_retry",
        },
        meta: { at: "2026-07-29T16:00:00.000Z" },
        type: "message.received",
      },
      context,
    );
    await events["message.completed"]?.(
      {
        data: {
          finishReason: "stop",
          message: "Retry this output",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_retry",
        },
        meta: { at: "2026-07-29T16:00:01.000Z" },
        type: "message.completed",
      },
      context,
    );

    telemetry.finish.mockRejectedValueOnce(new Error("Raindrop unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await events["turn.completed"]?.(
      {
        data: { sequence: 0, turnId: "turn_retry" },
        meta: { at: "2026-07-29T16:00:02.000Z" },
        type: "turn.completed",
      },
      context,
    );

    expect(warning).toHaveBeenCalledWith(
      "[raindrop] finish completed turn failed",
      "Raindrop unavailable",
    );
    expect(telemetry.finish).toHaveBeenCalledTimes(2);
    for (const [snapshot] of telemetry.finish.mock.calls) {
      expect(snapshot).toMatchObject({
        input: "Retry this input",
        output: "Retry this output",
        properties: {
          latency_ms: expect.any(Number),
          status: "completed",
          turn_started_at: "2026-07-29T16:00:00.000Z",
        },
      });
    }
    expect(telemetry.state.value).toEqual({});

    warning.mockRestore();
  });

  it("cleans up after the bounded terminal retry budget is exhausted", async () => {
    const events = await loadEvents();
    await events["message.received"]?.(
      {
        data: {
          message: "Unavailable input",
          parts: [{ text: "Unavailable input", type: "text" }],
          sequence: 0,
          turnId: "turn_unavailable",
        },
        meta: { at: "2026-07-29T17:00:00.000Z" },
        type: "message.received",
      },
      context,
    );

    telemetry.finish.mockRejectedValue(new Error("Raindrop unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await events["turn.completed"]?.(
      {
        data: { sequence: 0, turnId: "turn_unavailable" },
        meta: { at: "2026-07-29T17:00:02.000Z" },
        type: "turn.completed",
      },
      context,
    );

    expect(telemetry.finish).toHaveBeenCalledTimes(3);
    expect(warning).toHaveBeenLastCalledWith(
      "[raindrop] terminal export exhausted retries for turn turn_unavailable",
    );
    expect(telemetry.state.value).toEqual({});

    warning.mockRestore();
  });
});
