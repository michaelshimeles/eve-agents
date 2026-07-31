export type ArtifactScope = "thread" | "all";

export interface ArtifactTargetTransition {
  scope: ArtifactScope;
  selectedId: string | null;
}

/**
 * Reconcile an artifact target supplied by navigation with the workspace's
 * local selection. An echoed local selection needs no state change, while a
 * genuinely new direct link must be visible outside the current thread.
 */
export function artifactTargetTransition(
  selectedId: string | null,
  targetId: string | null | undefined,
): ArtifactTargetTransition | null {
  const nextSelectedId = targetId ?? null;
  if (nextSelectedId === selectedId) return null;
  return {
    scope: nextSelectedId === null ? "thread" : "all",
    selectedId: nextSelectedId,
  };
}
