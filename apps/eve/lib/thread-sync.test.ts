import { afterEach, describe, expect, it, vi } from "vitest";
import type { HandleMessageStreamEvent } from "eve/client";

import {
  LOCAL_CHAT_SAVED_EVENT,
  acceptedComputerSendNeedsRecovery,
  createPendingUserMessage,
  failPendingMessage,
  isVerifiedCatchUpStop,
  loadSavedChat,
  reconcilePendingMessage,
  saveLocalChat,
  savedChatHasProgress,
  sessionHasEventAt,
  type PendingUserMessage,
  type SavedChat,
} from "./thread-sync";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function received(
  parts: readonly (
    | { type: "text"; text: string }
    | { type: "file"; filename: string; mediaType: string; size?: number }
  )[],
): HandleMessageStreamEvent {
  return {
    type: "message.received",
    data: {
      message: parts
        .map((part) => (part.type === "text" ? part.text : `[file: ${part.filename}]`))
        .join("\n"),
      parts,
      sequence: 1,
      turnId: "turn-1",
    },
  } as HandleMessageStreamEvent;
}

function pendingText(text = "Keep this message"): PendingUserMessage {
  return createPendingUserMessage({
    id: "pending-1",
    createdAt: 100,
    baseEventCount: 0,
    text,
    files: [],
    useComputer: false,
  });
}

// The tail probe's contract: only a byte of event data proves the log
// continues, and only its own deadline elapsing proves the tail. On Vercel
// the streaming proxy flushes the response open with a bare newline before
// any event exists; that framing byte must read as silence, or every settled
// turn probes "behind" and the composer's catch-up long-polls forever with
// the stop button stuck.

/**
 * A fetch stub whose response streams `chunks` immediately. When `close` is
 * false the stream then stays open (the long-polling route at the tail);
 * aborting the probe's signal errors the stream like a real cancelled fetch.
 */
function streamingFetch(chunks: string[], { close = false, status = 200 } = {}) {
  return async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (close) {
          controller.close();
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          } catch {
            // Already closed or errored.
          }
        });
      },
    });
    return new Response(body, { status });
  };
}

describe("sessionHasEventAt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the tail when only a flush newline arrives before the deadline", async () => {
    vi.stubGlobal("fetch", streamingFetch(["\n"]));
    await expect(sessionHasEventAt("session", 3)).resolves.toBe(false);
  });

  it("reports the tail when the route stays silent until the deadline", async () => {
    vi.stubGlobal("fetch", streamingFetch([]));
    await expect(sessionHasEventAt("session", 3)).resolves.toBe(false);
  });

  it("reports an event when event data arrives", async () => {
    vi.stubGlobal("fetch", streamingFetch(['{"type":"turn.started"}\n']));
    await expect(sessionHasEventAt("session", 3)).resolves.toBe(true);
  });

  it("reports an event when data follows a flush newline", async () => {
    vi.stubGlobal("fetch", streamingFetch(["\n", '{"type":"turn.started"}\n']));
    await expect(sessionHasEventAt("session", 3)).resolves.toBe(true);
  });

  it("is inconclusive on an error status", async () => {
    vi.stubGlobal("fetch", streamingFetch([], { close: true, status: 500 }));
    await expect(sessionHasEventAt("session", 3)).resolves.toBe(true);
  });

  it("is inconclusive when the response closes empty", async () => {
    vi.stubGlobal("fetch", streamingFetch([], { close: true }));
    await expect(sessionHasEventAt("session", 3)).resolves.toBe(true);
  });

  it("is inconclusive on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      async () => {
        throw new TypeError("Failed to fetch");
      },
    );
    await expect(sessionHasEventAt("session", 3)).resolves.toBe(true);
  });
});

describe("recovery settlement", () => {
  it("releases shared ownership only after a verified tail or input park", () => {
    expect(isVerifiedCatchUpStop("tail")).toBe(true);
    expect(isVerifiedCatchUpStop("park")).toBe(true);
    expect(isVerifiedCatchUpStop("ended")).toBe(false);
    expect(isVerifiedCatchUpStop("failed")).toBe(false);
  });

  it("retains ownership only for an accepted Computer send without a boundary", () => {
    const before = { sessionId: "session", streamIndex: 2 };
    const accepted = { sessionId: "session", streamIndex: 2 };

    expect(
      acceptedComputerSendNeedsRecovery({
        useComputer: true,
        reachedBoundary: false,
        sessionBeforeSend: before,
        sessionAfterError: accepted,
      }),
    ).toBe(true);
    expect(
      acceptedComputerSendNeedsRecovery({
        useComputer: true,
        reachedBoundary: false,
        sessionBeforeSend: before,
        sessionAfterError: before,
      }),
    ).toBe(false);
    expect(
      acceptedComputerSendNeedsRecovery({
        useComputer: true,
        reachedBoundary: true,
        sessionBeforeSend: before,
        sessionAfterError: accepted,
      }),
    ).toBe(false);
    expect(
      acceptedComputerSendNeedsRecovery({
        useComputer: false,
        reachedBoundary: false,
        sessionBeforeSend: before,
        sessionAfterError: accepted,
      }),
    ).toBe(false);
  });
});

describe("pending user message persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes a pending text message and keeps it through a thread switch", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const pending = pendingText();

    saveLocalChat("thread-a", { events: [], pendingMessage: pending });
    saveLocalChat("thread-b", { events: [] });

    expect(loadSavedChat("thread-a")?.pendingMessage).toEqual(pending);
  });

  it("announces successful saves to same-tab listeners", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const listener = vi.fn();
    target.addEventListener(LOCAL_CHAT_SAVED_EVENT, listener);

    saveLocalChat("thread-a", { events: [], pendingMessage: pendingText() });

    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      threadId: "thread-a",
    });
  });

  it("projects attachment metadata without persisting attachment data URLs", () => {
    const attachment = {
      name: "report.pdf",
      mediaType: "application/pdf",
      size: 42_000,
      dataUrl: "data:application/pdf;base64,secret-bytes",
    };
    const pending = createPendingUserMessage({
      id: "pending-file",
      createdAt: 100,
      baseEventCount: 4,
      text: "",
      files: [
        {
          filename: attachment.name,
          mediaType: attachment.mediaType,
          size: attachment.size,
        },
      ],
      useComputer: true,
    });

    const serialized = JSON.stringify(pending);
    expect(pending.parts).toEqual([
      {
        type: "file",
        filename: "report.pdf",
        mediaType: "application/pdf",
        size: 42_000,
      },
    ]);
    expect(serialized).not.toContain("data:");
    expect(serialized).not.toContain("secret-bytes");
  });

  it("clears pending state only for the matching structured echo", () => {
    const pending = createPendingUserMessage({
      id: "pending-file",
      createdAt: 100,
      baseEventCount: 2,
      text: "Read this",
      files: [
        {
          filename: "notes.txt",
          mediaType: "text/plain",
          size: 12,
        },
      ],
      useComputer: false,
    });

    expect(
      reconcilePendingMessage(
        pending,
        received([
          { type: "text", text: "Read this" },
          {
            type: "file",
            filename: "notes.txt",
            mediaType: "text/plain",
            size: 12,
          },
        ]),
      ),
    ).toBeUndefined();
  });

  it("does not clear pending state for a stale or mismatched replay", () => {
    const pending = pendingText("new request");

    expect(
      reconcilePendingMessage(pending, received([{ type: "text", text: "older request" }])),
    ).toBe(pending);
    expect(
      reconcilePendingMessage(
        pending,
        { type: "turn.started", data: { turnId: "turn-old" } } as HandleMessageStreamEvent,
      ),
    ).toBe(pending);
  });

  it("persists a pre-confirmation failure", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const failed = failPendingMessage(pendingText(), "Network unavailable");
    saveLocalChat("thread-a", { events: [], pendingMessage: failed });

    expect(loadSavedChat("thread-a")?.pendingMessage).toMatchObject({
      status: "failed",
      error: "Network unavailable",
    });
  });
});

describe("saved chat progress", () => {
  const event = received([{ type: "text", text: "hello" }]);

  it("recognizes a newly available session id at equal event counts", () => {
    expect(
      savedChatHasProgress(
        { events: [], session: { streamIndex: 0 } },
        { events: [], session: { sessionId: "session-1", streamIndex: 0 } },
      ),
    ).toBe(true);
  });

  it("recognizes a greater stream index and pending transitions", () => {
    const sending = pendingText();
    expect(
      savedChatHasProgress(
        { events: [event], session: { sessionId: "s", streamIndex: 1 } },
        { events: [event], session: { sessionId: "s", streamIndex: 2 } },
      ),
    ).toBe(true);
    expect(
      savedChatHasProgress(
        { events: [event], pendingMessage: sending },
        { events: [event] },
      ),
    ).toBe(true);
    expect(
      savedChatHasProgress(
        { events: [event], pendingMessage: sending },
        {
          events: [event],
          pendingMessage: failPendingMessage(sending, "Interrupted"),
        },
      ),
    ).toBe(true);
  });

  it("recognizes a changed recovery state at equal event counts", () => {
    expect(
      savedChatHasProgress(
        { events: [event], behind: true },
        { events: [event] },
      ),
    ).toBe(true);
  });

  it("rejects a shorter authoritative event log", () => {
    const current: SavedChat = {
      events: [event, event],
      pendingMessage: pendingText(),
    };
    const incoming: SavedChat = {
      events: [event],
      session: { sessionId: "new", streamIndex: 10 },
      behind: true,
    };

    expect(savedChatHasProgress(current, incoming)).toBe(false);
  });
});
