import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionHasEventAt } from "./thread-sync";

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
