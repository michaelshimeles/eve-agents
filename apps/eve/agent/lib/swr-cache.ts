// Tiny stale-while-revalidate cache for per-turn agent context (memory
// profile, skill list). The first call blocks on the fetch; later calls
// return the cached value instantly and, once it is older than `ttlMs`,
// refresh it in the background. `invalidate()` forces the next call to
// block on a fresh fetch (use after writes).

export interface SwrCache<T> {
  get(): Promise<T>;
  invalidate(): void;
}

export function swrCache<T>(ttlMs: number, fetcher: () => Promise<T>): SwrCache<T> {
  let cached: { value: T; at: number } | undefined;
  let inflight: Promise<T> | undefined;

  function refresh(): Promise<T> {
    inflight ??= fetcher()
      .then((value) => {
        cached = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return {
    async get(): Promise<T> {
      if (cached === undefined) return refresh();
      if (Date.now() - cached.at > ttlMs) {
        // Serve stale immediately; a background refresh failure keeps the
        // last good value until the next attempt.
        void refresh().catch(() => undefined);
      }
      return cached.value;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
