const MAX_STREAM_SNAPSHOTS = 8;

/**
 * Build safe post-generation snapshots from complete markdown. Eve exposes
 * token deltas before we know whether a step will become a tool call; sending
 * those could leak internal tool narration. Waiting for `message.completed`
 * and then revealing complete markdown blocks gives Messages the evolving
 * bubble without exposing speculative/internal text.
 */
export function iMessageMarkdownSnapshots(text: string): readonly string[] {
  const normalized = text.trim();
  if (normalized.length === 0) return [];
  const blocks = normalized
    .split(/\n[ \t]*\n+/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (blocks.length <= 1) return [normalized];

  const stride = Math.max(1, Math.ceil(blocks.length / MAX_STREAM_SNAPSHOTS));
  const snapshots: string[] = [];
  for (let count = stride; count < blocks.length; count += stride) {
    snapshots.push(blocks.slice(0, count).join("\n\n"));
  }
  snapshots.push(blocks.join("\n\n"));
  return snapshots;
}
