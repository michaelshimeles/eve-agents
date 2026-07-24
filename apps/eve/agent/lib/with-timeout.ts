/**
 * Bounds how long a promise may block the caller. On timeout the original
 * promise keeps running (useful for SWR caches, which it fills for next
 * time); its eventual rejection is swallowed so an abandoned fetch can't
 * become an unhandled rejection.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          promise.catch(() => undefined);
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
