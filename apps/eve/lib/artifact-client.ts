import type { HandleMessageStreamEvent } from "eve/client";

import type {
  ArtifactComment,
  ArtifactDescriptor,
  ArtifactShare,
  ArtifactVersion,
} from "@/agent/lib/effect/artifacts";
import { createAsyncLruCache } from "@/lib/async-lru-cache";
import { isUuid } from "@/lib/artifact-api";

export const ARTIFACTS_CHANGED_EVENT = "eve:artifacts-changed";

export interface ArtifactChange {
  readonly artifactId: string;
  readonly versionId?: string;
}

export interface ArtifactDetail {
  artifact: ArtifactDescriptor;
  versions: ArtifactVersion[];
  comments: ArtifactComment[];
}

const artifactDetails = createAsyncLruCache<string, ArtifactDetail>({
  maxEntries: 50,
});
const artifactLists = createAsyncLruCache<string, ArtifactDescriptor[]>({
  maxEntries: 30,
});
const artifactTexts = createAsyncLruCache<string, string>({ maxEntries: 20 });
const artifactDrafts = createAsyncLruCache<
  string,
  { draft?: { content?: string } | null }
>({ maxEntries: 50 });
const artifactShares = createAsyncLruCache<string, ArtifactShare[]>({
  maxEntries: 50,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArtifactTool(toolName: string): boolean {
  return (
    toolName === "artifact_create" ||
    toolName === "artifact_update" ||
    toolName.endsWith(":artifact_create") ||
    toolName.endsWith(":artifact_update")
  );
}

export function artifactChangeFromStreamEvent(
  event: HandleMessageStreamEvent,
): ArtifactChange | null {
  if (
    event.type !== "action.result" ||
    event.data.status !== "completed" ||
    event.data.result.kind !== "tool-result" ||
    event.data.result.isError === true ||
    !isArtifactTool(event.data.result.toolName) ||
    !isRecord(event.data.result.output)
  ) {
    return null;
  }
  const artifactId = event.data.result.output.artifactId;
  const versionId = event.data.result.output.versionId;
  if (!isUuid(artifactId)) return null;
  return {
    artifactId,
    ...(isUuid(versionId) ? { versionId } : {}),
  };
}

export function artifactChangeFromDomEvent(event: Event): ArtifactChange | null {
  if (!(event instanceof CustomEvent) || !isRecord(event.detail)) return null;
  const artifactId = event.detail.artifactId;
  const versionId = event.detail.versionId;
  if (!isUuid(artifactId)) return null;
  return {
    artifactId,
    ...(isUuid(versionId) ? { versionId } : {}),
  };
}

export function notifyArtifactsChanged(change?: ArtifactChange): void {
  window.dispatchEvent(
    change === undefined
      ? new Event(ARTIFACTS_CHANGED_EVENT)
      : new CustomEvent<ArtifactChange>(ARTIFACTS_CHANGED_EVENT, { detail: change }),
  );
}

export function artifactIdFromHref(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.searchParams.get("workspace") !== "artifacts") {
    return null;
  }
  const artifactId = url.searchParams.get("artifact");
  return isUuid(artifactId) ? artifactId : null;
}

export function openArtifactWorkspace(artifactId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("desktop", "1");
  url.searchParams.set("workspace", "artifacts");
  url.searchParams.set("artifact", artifactId);
  const target = url.pathname + url.search;
  if (window.location.pathname + window.location.search !== target) {
    window.history.pushState(null, "", target);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function peekArtifactDetail(artifactId: string): ArtifactDetail | undefined {
  return artifactDetails.peek(artifactId);
}

export function loadArtifactDetail(
  artifactId: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<ArtifactDetail> {
  if (fresh) artifactDetails.delete(artifactId);
  return artifactDetails.get(artifactId, async () => {
    const response = await fetch(`/api/artifacts/${artifactId}`, {
      cache: fresh ? "no-store" : "default",
    });
    const body = (await response.json()) as ArtifactDetail & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not load artifact.");
    return body;
  });
}

export function peekArtifactList(cacheKey: string): ArtifactDescriptor[] | undefined {
  return artifactLists.peek(cacheKey);
}

export function loadArtifactList(
  cacheKey: string,
  url: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<ArtifactDescriptor[]> {
  if (fresh) artifactLists.delete(cacheKey);
  return artifactLists.get(cacheKey, async () => {
    const response = await fetch(url, { cache: fresh ? "no-store" : "default" });
    const body = (await response.json()) as {
      artifacts?: ArtifactDescriptor[];
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? "Could not load artifacts.");
    return body.artifacts ?? [];
  });
}

export function loadArtifactText(contentUrl: string): Promise<string> {
  return artifactTexts.get(contentUrl, async () => {
    const response = await fetch(contentUrl);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? "Could not load artifact content.");
    }
    return response.text();
  });
}

export function setArtifactDraft(
  artifactId: string,
  draft: { content?: string } | null,
): void {
  artifactDrafts.set(artifactId, { draft });
}

export function loadArtifactDraft(
  artifactId: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<{ draft?: { content?: string } | null }> {
  if (fresh) artifactDrafts.delete(artifactId);
  return artifactDrafts.get(artifactId, async () => {
    const response = await fetch(`/api/artifacts/${artifactId}/draft`, {
      cache: "no-store",
    });
    if (!response.ok) return { draft: null };
    return (await response.json()) as { draft?: { content?: string } | null };
  });
}

export function setArtifactShares(
  artifactId: string,
  shares: ArtifactShare[],
): void {
  artifactShares.set(artifactId, shares);
}

export function loadArtifactShares(
  artifactId: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<ArtifactShare[]> {
  if (fresh) artifactShares.delete(artifactId);
  return artifactShares.get(artifactId, async () => {
    const response = await fetch(`/api/artifacts/${artifactId}/shares`, {
      cache: "no-store",
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { shares?: ArtifactShare[] };
    return body.shares ?? [];
  });
}
