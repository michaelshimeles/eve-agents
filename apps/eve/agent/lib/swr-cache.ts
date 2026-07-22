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
  let generation = 0;

  function refresh(): Promise<T> {
    if (inflight === undefined) {
      const startedAt = generation;
      inflight = fetcher()
        .then((value) => {
          // A refresh that began before an invalidation may carry pre-write
          // data; only a fetch started after the invalidation may fill the
          // cache.
          if (generation === startedAt) cached = { value, at: Date.now() };
          return value;
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
  }

  return {
    async get(): Promise<T> {
      if (cached === undefined) {
        const value = await refresh();
        // If an invalidation raced this fetch, retry once with fresh data.
        return cached === undefined ? await refresh() : value;
      }
      if (Date.now() - cached.at > ttlMs) {
        // Serve stale immediately; a background refresh failure keeps the
        // last good value until the next attempt.
        void refresh().catch(() => undefined);
      }
      return cached.value;
    },
    invalidate() {
      generation += 1;
      cached = undefined;
    },
  };
}
