interface AsyncCacheEntry<Value> {
  readonly promise: Promise<Value>;
  value?: Value;
}

export interface AsyncLruCache<Key, Value> {
  delete(key: Key): void;
  get(key: Key, load: () => Promise<Value>): Promise<Value>;
  peek(key: Key): Value | undefined;
  set(key: Key, value: Value): void;
}

/**
 * Small client-side cache for immutable artifact revisions and their parsed
 * previews. Pending reads are deduplicated, resolved values are returned
 * synchronously through `peek`, and removing an in-flight entry prevents its
 * stale result from being installed later.
 */
export function createAsyncLruCache<Key, Value>({
  maxEntries,
  onEvict,
}: {
  maxEntries: number;
  onEvict?: (value: Value) => void;
}): AsyncLruCache<Key, Value> {
  const entries = new Map<Key, AsyncCacheEntry<Value>>();

  function evict(entry: AsyncCacheEntry<Value>): void {
    if (onEvict === undefined) return;
    if (entry.value !== undefined) {
      onEvict(entry.value);
      return;
    }
    void entry.promise.then(onEvict).catch(() => undefined);
  }

  function trim(): void {
    while (entries.size > maxEntries) {
      const oldest = entries.entries().next().value as
        | [Key, AsyncCacheEntry<Value>]
        | undefined;
      if (oldest === undefined) return;
      entries.delete(oldest[0]);
      evict(oldest[1]);
    }
  }

  function touch(key: Key, entry: AsyncCacheEntry<Value>): void {
    entries.delete(key);
    entries.set(key, entry);
  }

  return {
    delete(key) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entries.delete(key);
      evict(entry);
    },
    get(key, load) {
      const existing = entries.get(key);
      if (existing !== undefined) {
        touch(key, existing);
        return existing.promise;
      }

      const entry: AsyncCacheEntry<Value> = {
        promise: Promise.resolve().then(load),
      };
      entries.set(key, entry);
      trim();
      void entry.promise.then(
        (value) => {
          if (entries.get(key) !== entry) return;
          entry.value = value;
          touch(key, entry);
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );
      return entry.promise;
    },
    peek(key) {
      const entry = entries.get(key);
      if (entry?.value === undefined) return undefined;
      touch(key, entry);
      return entry.value;
    },
    set(key, value) {
      const existing = entries.get(key);
      if (existing !== undefined) {
        entries.delete(key);
        evict(existing);
      }
      entries.set(key, { promise: Promise.resolve(value), value });
      trim();
    },
  };
}
