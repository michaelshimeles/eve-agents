import { describe, expect, it, vi } from "vitest";

import { createAsyncLruCache } from "./async-lru-cache";

describe("async LRU cache", () => {
  it("deduplicates pending loads and exposes resolved values synchronously", async () => {
    const load = vi.fn(async () => "artifact");
    const cache = createAsyncLruCache<string, string>({ maxEntries: 2 });

    const first = cache.get("one", load);
    const second = cache.get("one", load);

    await expect(Promise.all([first, second])).resolves.toEqual(["artifact", "artifact"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.peek("one")).toBe("artifact");
  });

  it("does not reinstall an in-flight value after invalidation", async () => {
    let resolve!: (value: string) => void;
    const cache = createAsyncLruCache<string, string>({ maxEntries: 2 });
    const pending = cache.get(
      "one",
      () => new Promise<string>((next) => {
        resolve = next;
      }),
    );

    await Promise.resolve();
    cache.delete("one");
    resolve("stale");
    await pending;

    expect(cache.peek("one")).toBeUndefined();
  });

  it("evicts the least recently used resolved value", async () => {
    const evicted: string[] = [];
    const cache = createAsyncLruCache<string, string>({
      maxEntries: 2,
      onEvict: (value) => evicted.push(value),
    });
    await cache.get("one", async () => "first");
    await cache.get("two", async () => "second");
    expect(cache.peek("one")).toBe("first");
    await cache.get("three", async () => "third");

    expect(cache.peek("two")).toBeUndefined();
    expect(evicted).toEqual(["second"]);
  });

  it("can prime a resolved value without loading", async () => {
    const cache = createAsyncLruCache<string, string>({ maxEntries: 2 });
    const load = vi.fn(async () => "loaded");
    cache.set("one", "primed");

    expect(cache.peek("one")).toBe("primed");
    await expect(cache.get("one", load)).resolves.toBe("primed");
    expect(load).not.toHaveBeenCalled();
  });
});
