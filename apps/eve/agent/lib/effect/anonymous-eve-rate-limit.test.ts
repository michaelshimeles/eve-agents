import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AnonymousEveRateLimitLive,
  anonymousEveCallerHash,
  checkAnonymousEveRateLimit,
  isAnonymousEveMessageRequest,
} from "./anonymous-eve-rate-limit";
import { DatabaseError, Db, type DbRow } from "./db";

function rateLimitRuntime(rows: readonly DbRow[]) {
  const query = vi.fn(() => Effect.succeed([...rows]));
  const transaction = vi.fn(() => Effect.succeed([] as const));
  const DbTest = Layer.succeed(Db, { query, transaction });
  const RateLimitTest = AnonymousEveRateLimitLive.pipe(Layer.provide(DbTest));
  return {
    query,
    transaction,
    runtime: ManagedRuntime.make(RateLimitTest),
  };
}

describe("anonymous Eve rate limit", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://rate-limit.test/database");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("counts message creation and continuation but not control routes", () => {
    expect(
      isAnonymousEveMessageRequest(
        new Request("https://ruth.example/eve/v1/session", { method: "POST" }),
      ),
    ).toBe(true);
    expect(
      isAnonymousEveMessageRequest(
        new Request("https://ruth.example/eve/v1/session/session-1", { method: "POST" }),
      ),
    ).toBe(true);
    expect(
      isAnonymousEveMessageRequest(
        new Request("https://ruth.example/eve/v1/session/reset", { method: "POST" }),
      ),
    ).toBe(false);
    expect(
      isAnonymousEveMessageRequest(
        new Request("https://ruth.example/eve/v1/session/session-1/cancel", {
          method: "POST",
        }),
      ),
    ).toBe(false);
    expect(
      isAnonymousEveMessageRequest(
        new Request("https://ruth.example/eve/v1/session/session-1/stream"),
      ),
    ).toBe(false);
  });

  it("uses the Vercel-authenticated client address without storing the raw IP", () => {
    const first = anonymousEveCallerHash(
      new Request("https://ruth.example/eve/v1/session", {
        headers: {
          "x-vercel-forwarded-for": "203.0.113.10",
          "x-forwarded-for": "198.51.100.20",
        },
      }),
    );
    const same = anonymousEveCallerHash(
      new Request("https://ruth.example/eve/v1/session", {
        headers: { "x-vercel-forwarded-for": "203.0.113.10" },
      }),
    );
    const different = anonymousEveCallerHash(
      new Request("https://ruth.example/eve/v1/session", {
        headers: { "x-vercel-forwarded-for": "203.0.113.11" },
      }),
    );

    expect(first).toBe(same);
    expect(first).not.toBe(different);
    expect(first).not.toContain("203.0.113.10");
  });

  it("allows callers whose minute and daily windows are within budget", async () => {
    const fixture = rateLimitRuntime([
      {
        window_kind: "day",
        request_count: 100,
        max_requests: 500,
        retry_after_seconds: 3600,
      },
      {
        window_kind: "minute",
        request_count: 20,
        max_requests: 20,
        retry_after_seconds: 15,
      },
    ]);

    await expect(
      fixture.runtime.runPromise(checkAnonymousEveRateLimit("caller")),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.query).toHaveBeenCalledWith(expect.any(String), ["caller", 20, 500]);
    await fixture.runtime.dispose();
  });

  it("denies a caller until the longest exceeded window resets", async () => {
    const fixture = rateLimitRuntime([
      {
        window_kind: "day",
        request_count: 501,
        max_requests: 500,
        retry_after_seconds: 7200,
      },
      {
        window_kind: "minute",
        request_count: 21,
        max_requests: 20,
        retry_after_seconds: 12,
      },
    ]);

    await expect(
      fixture.runtime.runPromise(checkAnonymousEveRateLimit("caller")),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 7200 });
    await fixture.runtime.dispose();
  });

  it("initializes the durable table once per runtime", async () => {
    const fixture = rateLimitRuntime([
      {
        window_kind: "minute",
        request_count: 1,
        max_requests: 20,
        retry_after_seconds: 59,
      },
      {
        window_kind: "day",
        request_count: 1,
        max_requests: 500,
        retry_after_seconds: 86399,
      },
    ]);

    await fixture.runtime.runPromise(checkAnonymousEveRateLimit("first"));
    await fixture.runtime.runPromise(checkAnonymousEveRateLimit("second"));

    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.query).toHaveBeenCalledTimes(2);
    await fixture.runtime.dispose();
  });

  it("fails closed when configured durable accounting is unavailable", async () => {
    const query = vi.fn(() =>
      Effect.fail(new DatabaseError({ cause: new Error("database unavailable") })),
    );
    const transaction = vi.fn(() => Effect.succeed([] as const));
    const DbTest = Layer.succeed(Db, { query, transaction });
    const RateLimitTest = AnonymousEveRateLimitLive.pipe(Layer.provide(DbTest));
    const runtime = ManagedRuntime.make(RateLimitTest);

    await expect(
      runtime.runPromise(checkAnonymousEveRateLimit("exhausted-caller")),
    ).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it("keeps the open local web chat usable without a database", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const fixture = rateLimitRuntime([]);

    await expect(
      fixture.runtime.runPromise(checkAnonymousEveRateLimit("caller")),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.query).not.toHaveBeenCalled();
    await fixture.runtime.dispose();
  });

  it("still enforces a bounded process-local fallback without a database", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-30T12:00:00.000Z");
    const fixture = rateLimitRuntime([]);

    for (let request = 0; request < 20; request += 1) {
      await expect(
        fixture.runtime.runPromise(checkAnonymousEveRateLimit("caller")),
      ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    await expect(
      fixture.runtime.runPromise(checkAnonymousEveRateLimit("caller")),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });

    vi.advanceTimersByTime(60_000);
    await expect(
      fixture.runtime.runPromise(checkAnonymousEveRateLimit("caller")),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await fixture.runtime.dispose();
  });
});
