/** RFC 2606 example domain: this address cannot receive real mail. */
export const BLACKHOLE_EMAIL = "contractor-eval@example.com";

/** NANP 555-01xx reserved fictional range. */
export const FICTIONAL_PHONE = "+1 416 555 0142";

/** Unique enough for one eval run and easy to find for cleanup. */
export function evalMarker(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}
