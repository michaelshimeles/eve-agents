import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceThreadWriter, loadVoiceResume, saveVoiceResume } from "./thread";

function stubBrowser(): Record<string, string> {
  const store: Record<string, string> = {};
  const localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
  const win = {
    localStorage,
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  return store;
}

describe("VoiceThreadWriter", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    vi.useFakeTimers();
    store = stubBrowser();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates a fresh thread, appends an exchange, persists without a session cursor", async () => {
    const writer = await VoiceThreadWriter.open();
    writer.appendUser("hey Ruth");
    writer.appendAssistant("hey! what's up?");
    writer.finish("eve:tok-1");
    await vi.runAllTimersAsync();
    const saved = JSON.parse(store[`eve-web-chat:${writer.threadId}`] ?? "{}") as {
      events?: Array<{ type: string }>;
      session?: unknown;
      forkContext?: string;
    };
    expect(saved.session).toBeUndefined();
    expect(saved.events?.map((event) => event.type)).toEqual([
      "message.received",
      "message.completed",
      "turn.completed",
    ]);
    expect(saved.forkContext).toContain("hey Ruth");
    const resume = loadVoiceResume();
    expect(resume?.threadId).toBe(writer.threadId);
    expect(resume?.continuationToken).toBe("eve:tok-1");
  });

  it("reuses a recent thread and seeds the transcript from its events", async () => {
    const first = await VoiceThreadWriter.open();
    first.appendUser("remember the milk");
    first.appendAssistant("noted");
    first.finish("eve:tok-2");
    await vi.runAllTimersAsync();
    const second = await VoiceThreadWriter.open();
    expect(second.threadId).toBe(first.threadId);
    expect(second.transcript.map((entry) => entry.text)).toEqual(["remember the milk", "noted"]);
    expect(second.resumeToken).toBe("eve:tok-2");
  });

  it("starts fresh when the resume record is stale", async () => {
    const first = await VoiceThreadWriter.open();
    first.finish();
    await vi.runAllTimersAsync();
    saveVoiceResume({ ...(loadVoiceResume() as NonNullable<ReturnType<typeof loadVoiceResume>>), endedAt: Date.now() - 31 * 60_000 });
    const second = await VoiceThreadWriter.open();
    expect(second.threadId).not.toBe(first.threadId);
  });

  it("starts fresh when the server copy grew a session cursor (text takeover)", async () => {
    const first = await VoiceThreadWriter.open();
    first.finish();
    await vi.runAllTimersAsync();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ chat: { events: [], session: { streamIndex: 3, sessionId: "s" } } }), { status: 200 }),
    ));
    const second = await VoiceThreadWriter.open();
    expect(second.threadId).not.toBe(first.threadId);
  });

  it("stops writing once a text session adopts the thread mid-conversation", async () => {
    const writer = await VoiceThreadWriter.open();
    writer.appendUser("first line");
    await vi.runAllTimersAsync();
    const key = `eve-web-chat:${writer.threadId}`;
    // A text session takes the thread over while the orb is still open.
    store[key] = JSON.stringify({
      events: [{ type: "message.received", data: { message: "typed", sequence: 1, turnId: "t" } }, { type: "turn.completed", data: {} }],
      session: { sessionId: "s", streamIndex: 2 },
      savedAt: Date.now(),
    });
    writer.appendUser("second line");
    await vi.runAllTimersAsync();
    const after = JSON.parse(store[key] ?? "{}") as { session?: unknown; events?: unknown[] };
    expect(after.session).toBeDefined();
    expect(after.events).toHaveLength(2);
  });

  it("never overwrites a longer stored log with a shorter one", async () => {
    const writer = await VoiceThreadWriter.open();
    writer.appendUser("hello");
    await vi.runAllTimersAsync();
    const key = `eve-web-chat:${writer.threadId}`;
    const longer = Array.from({ length: 9 }, (_, i) => ({ type: "turn.completed", data: { sequence: i } }));
    store[key] = JSON.stringify({ events: longer, savedAt: Date.now() });
    writer.appendUser("hi again");
    await vi.runAllTimersAsync();
    const after = JSON.parse(store[key] ?? "{}") as { events?: unknown[] };
    expect(after.events).toHaveLength(9);
  });

  it("survives a malformed resume record", async () => {
    store["eve-voice-last"] = JSON.stringify({ threadId: "abc", endedAt: Date.now() });
    const resume = loadVoiceResume();
    expect(typeof resume?.title).toBe("string");
    expect(resume?.title.length).toBeGreaterThan(0);
    store["eve-voice-last"] = "{not json";
    expect(loadVoiceResume()).toBeNull();
  });
});
