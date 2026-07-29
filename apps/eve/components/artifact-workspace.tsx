"use client";

import { upload } from "@vercel/blob/client";
import { Badge, Button, Input, Loader } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  FileArrowUpIcon,
  FileIcon,
  FloppyDiskIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ArtifactComment,
  ArtifactDescriptor,
  ArtifactShare,
  ArtifactVersion,
} from "@/agent/lib/effect/artifacts";
import { ArtifactPreview } from "@/components/artifact-preview";
import {
  artifactTargetTransition,
  type ArtifactScope,
} from "@/lib/artifact-workspace-state";
import { cn } from "@/lib/utils";

interface ArtifactDetail {
  artifact: ArtifactDescriptor;
  versions: ArtifactVersion[];
  comments: ArtifactComment[];
}

function artifactMime(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (extension === "md" || extension === "markdown") return "text/markdown";
  if (extension === "html" || extension === "htm") return "text/html";
  if (extension === "pdf") return "application/pdf";
  if (extension === "csv") return "text/csv";
  if (extension === "xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (extension === "pptx") {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  return "application/octet-stream";
}

function acceptedArtifact(file: File): boolean {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  return ["md", "markdown", "html", "htm", "pdf", "csv", "xlsx", "pptx"].includes(
    extension ?? "",
  );
}

function safePathname(filename: string): string {
  return filename
    .normalize("NFKC")
    .replaceAll(/[/\\\u0000-\u001f\u007f]/g, "-")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "artifact";
}

async function fileSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function relativeDate(value: string): string {
  const timestamp = new Date(value).getTime();
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString();
}

function selectionLabel(selection: unknown): string | null {
  if (selection === null || typeof selection !== "object") return null;
  const value = selection as Record<string, unknown>;
  if (value.type === "sheet-range") return `${String(value.sheet)} · ${String(value.range)}`;
  if (value.type === "slide") return `Slide ${String(value.slide)}`;
  if (value.type === "page") return "Current PDF page";
  if (value.type === "text") return `Text ${String(value.start)}–${String(value.end)}`;
  return null;
}

export function ArtifactWorkspace({
  threadId,
  initialArtifactId,
  onArtifactChange,
}: {
  threadId: string;
  initialArtifactId?: string | null;
  onArtifactChange?: (artifactId: string | null) => void;
}) {
  const [scope, setScope] = useState<ArtifactScope>(
    initialArtifactId ? "all" : "thread",
  );
  const [query, setQuery] = useState("");
  const [artifacts, setArtifacts] = useState<ArtifactDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialArtifactId ?? null);
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "edit">("preview");
  const [editorText, setEditorText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [selection, setSelection] = useState<unknown>(null);
  const [comment, setComment] = useState("");
  const [shares, setShares] = useState<ArtifactShare[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const revisionInput = useRef<HTMLInputElement>(null);
  const selectedIdRef = useRef(selectedId);
  const onArtifactChangeRef = useRef(onArtifactChange);
  const artifactListRequestRef = useRef(0);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    onArtifactChangeRef.current = onArtifactChange;
  }, [onArtifactChange]);

  useEffect(() => {
    const transition = artifactTargetTransition(
      selectedIdRef.current,
      initialArtifactId,
    );
    if (transition === null) return;
    setScope(transition.scope);
    setSelectedId(transition.selectedId);
  }, [initialArtifactId]);

  const loadArtifacts = useCallback(async () => {
    const requestId = ++artifactListRequestRef.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (scope === "thread") params.set("threadId", threadId);
    if (query.trim()) params.set("q", query.trim());
    try {
      const response = await fetch(`/api/artifacts?${params}`);
      const body = (await response.json()) as {
        artifacts?: ArtifactDescriptor[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Could not load artifacts.");
      const next = body.artifacts ?? [];
      if (requestId !== artifactListRequestRef.current) return;
      setArtifacts(next);
      setSelectedId((current) => {
        if (requestId !== artifactListRequestRef.current) return current;
        if (current !== null && next.some((artifact) => artifact.id === current)) return current;
        if (initialArtifactId && next.some((artifact) => artifact.id === initialArtifactId)) {
          return initialArtifactId;
        }
        return next[0]?.id ?? null;
      });
    } catch (cause) {
      if (requestId !== artifactListRequestRef.current) return;
      setArtifacts([]);
      setError(cause instanceof Error ? cause.message : "Could not load artifacts.");
    } finally {
      if (requestId === artifactListRequestRef.current) setLoading(false);
    }
  }, [initialArtifactId, query, scope, threadId]);

  useEffect(() => {
    const timer = setTimeout(() => void loadArtifacts(), query.trim() ? 250 : 0);
    function changed() {
      void loadArtifacts();
    }
    window.addEventListener("eve:artifacts-changed", changed);
    return () => {
      artifactListRequestRef.current += 1;
      clearTimeout(timer);
      window.removeEventListener("eve:artifacts-changed", changed);
    };
  }, [loadArtifacts, query]);

  useEffect(() => {
    onArtifactChangeRef.current?.(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setError(null);
    setDetailError(null);
    void fetch(`/api/artifacts/${selectedId}`)
      .then(async (response) => {
        const body = (await response.json()) as ArtifactDetail & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Could not load artifact.");
        return body;
      })
      .then(async (next) => {
        if (cancelled) return;
        setDetail(next);
        setSelectedVersionId(next.artifact.currentVersionId);
        setSelection(null);
        setShareUrl(null);
        setShares([]);
        void fetch(`/api/artifacts/${selectedId}/shares`)
          .then((response) => (response.ok ? response.json() : null))
          .then((body: { shares?: ArtifactShare[] } | null) => {
            if (!cancelled) setShares(body?.shares ?? []);
          })
          .catch(() => undefined);
        const editable =
          next.artifact.kind === "markdown" || next.artifact.kind === "html";
        if (!editable) {
          setViewMode("preview");
          return;
        }
        const [contentResponse, draftResponse] = await Promise.all([
          fetch(`/api/artifacts/${selectedId}/content`),
          fetch(`/api/artifacts/${selectedId}/draft`),
        ]);
        if (!contentResponse.ok) {
          const body = (await contentResponse.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? "Could not load artifact content.");
        }
        const content = await contentResponse.text();
        const draftBody = draftResponse.ok
          ? ((await draftResponse.json()) as { draft?: { content?: string } | null })
          : null;
        if (cancelled) return;
        setSavedText(content);
        setEditorText(draftBody?.draft?.content ?? content);
        setDraftStatus("idle");
      })
      .catch((cause) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(cause instanceof Error ? cause.message : "Could not load artifact.");
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const artifact = detail?.artifact ?? null;
  const selectedVersion = useMemo(
    () =>
      detail?.versions.find((version) => version.id === selectedVersionId) ??
      detail?.versions[0] ??
      null,
    [detail, selectedVersionId],
  );
  const editable = artifact?.kind === "markdown" || artifact?.kind === "html";
  const editingCurrent =
    editable &&
    artifact !== null &&
    selectedVersion !== null &&
    selectedVersion.id === artifact.currentVersionId;

  useEffect(() => {
    if (!editable || artifact === null || editorText === savedText) {
      if (editorText === savedText) setDraftStatus("idle");
      return;
    }
    setDraftStatus("saving");
    const timer = setTimeout(() => {
      void fetch(`/api/artifacts/${artifact.id}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editorText }),
      })
        .then((response) => {
          if (!response.ok) throw new Error("Draft autosave failed.");
          setDraftStatus("saved");
        })
        .catch(() => setDraftStatus("error"));
    }, 700);
    return () => clearTimeout(timer);
  }, [artifact, editable, editorText, savedText]);

  async function uploadBlob(file: File, artifactId: string, versionId: string) {
    if (!acceptedArtifact(file)) {
      throw new Error("Use Markdown, HTML, PDF, CSV, XLSX, or PPTX.");
    }
    if (file.size > 50 * 1024 * 1024) throw new Error("Artifacts are limited to 50 MB.");
    const pathname = `artifacts/${artifactId}/${versionId}/${safePathname(file.name)}`;
    const [blob, sha256] = await Promise.all([
      upload(pathname, file, {
        access: "private",
        handleUploadUrl: "/api/artifacts/upload",
        clientPayload: JSON.stringify({ artifactId, versionId }),
        contentType: artifactMime(file),
        multipart: file.size > 5 * 1024 * 1024,
      }),
      fileSha256(file),
    ]);
    return { blob, sha256 };
  }

  async function addArtifact(file: File) {
    setBusy(true);
    setError(null);
    try {
      const artifactId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      const { blob, sha256 } = await uploadBlob(file, artifactId, versionId);
      const response = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId,
          versionId,
          title: file.name.replace(/\.[^.]+$/, "") || file.name,
          filename: file.name,
          mimeType: artifactMime(file),
          threadId,
          blob: {
            url: blob.url,
            pathname: blob.pathname,
            size: file.size,
            sha256,
          },
        }),
      });
      const body = (await response.json()) as {
        artifact?: ArtifactDescriptor;
        error?: string;
      };
      if (!response.ok || body.artifact === undefined) {
        throw new Error(body.error ?? "Could not register artifact.");
      }
      setScope("all");
      setSelectedId(body.artifact.id);
      window.dispatchEvent(new Event("eve:artifacts-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload artifact.");
    } finally {
      setBusy(false);
    }
  }

  async function addRevision(file: File) {
    if (artifact === null) return;
    setBusy(true);
    setError(null);
    try {
      const versionId = crypto.randomUUID();
      const { blob, sha256 } = await uploadBlob(file, artifact.id, versionId);
      const response = await fetch(`/api/artifacts/${artifact.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId,
          filename: file.name,
          mimeType: artifactMime(file),
          changeSummary: "Uploaded from the workspace",
          blob: {
            url: blob.url,
            pathname: blob.pathname,
            size: file.size,
            sha256,
          },
        }),
      });
      const body = (await response.json()) as {
        artifact?: ArtifactDescriptor;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Could not save revision.");
      window.dispatchEvent(new Event("eve:artifacts-changed"));
      setSelectedId(null);
      queueMicrotask(() => setSelectedId(artifact.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save revision.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTextRevision() {
    if (!editable || artifact === null || selectedVersion === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/artifacts/${artifact.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: crypto.randomUUID(),
          filename: selectedVersion.filename,
          mimeType: artifact.mimeType,
          content: editorText,
          changeSummary: "Edited in the workspace",
        }),
      });
      const body = (await response.json()) as {
        artifact?: ArtifactDescriptor;
        error?: string;
      };
      if (!response.ok || body.artifact === undefined) {
        throw new Error(body.error ?? "Could not save revision.");
      }
      setSavedText(editorText);
      setDraftStatus("idle");
      await fetch(`/api/artifacts/${artifact.id}/draft`, { method: "DELETE" });
      window.dispatchEvent(new Event("eve:artifacts-changed"));
      setSelectedId(null);
      queueMicrotask(() => setSelectedId(artifact.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save revision.");
    } finally {
      setBusy(false);
    }
  }

  async function restore(versionId: string) {
    if (artifact === null) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/artifacts/${artifact.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not restore revision.");
      window.dispatchEvent(new Event("eve:artifacts-changed"));
      setSelectedId(null);
      queueMicrotask(() => setSelectedId(artifact.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore revision.");
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    if (artifact === null || selectedVersion === null) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/artifacts/${artifact.id}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId: selectedVersion.id, expiresInDays: 7 }),
      });
      const body = (await response.json()) as {
        url?: string;
        share?: ArtifactShare;
        error?: string;
      };
      if (!response.ok || body.url === undefined) {
        throw new Error(body.error ?? "Could not create share.");
      }
      setShareUrl(body.url);
      if (body.share !== undefined) {
        setShares((current) => [body.share as ArtifactShare, ...current]);
      }
      await navigator.clipboard.writeText(body.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create share.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeShare(shareId: string) {
    if (artifact === null) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/artifacts/${artifact.id}/shares/${shareId}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not revoke share.");
      setShares((current) =>
        current.map((entry) =>
          entry.id === shareId ? { ...entry, revokedAt: new Date().toISOString() } : entry,
        ),
      );
      setShareUrl(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke share.");
    } finally {
      setBusy(false);
    }
  }

  async function addComment() {
    if (artifact === null || selectedVersion === null || !comment.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/artifacts/${artifact.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: selectedVersion.id,
          body: comment.trim(),
          ...(selection === null ? {} : { selection }),
        }),
      });
      const body = (await response.json()) as {
        comment?: ArtifactComment;
        error?: string;
      };
      if (!response.ok || body.comment === undefined) {
        throw new Error(body.error ?? "Could not add comment.");
      }
      setDetail((current) =>
        current === null
          ? current
          : { ...current, comments: [body.comment as ArtifactComment, ...current.comments] },
      );
      setComment("");
      setSelection(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add comment.");
    } finally {
      setBusy(false);
    }
  }

  const contentUrl =
    artifact !== null && selectedVersion !== null
      ? `/api/artifacts/${artifact.id}/content?versionId=${selectedVersion.id}`
      : "";

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex w-48 shrink-0 flex-col border-e border-kumo-hairline">
        <div className="flex items-center gap-1 border-b border-kumo-hairline p-2">
          <div role="tablist" aria-label="Artifact scope" className="flex min-w-0 flex-1 gap-1">
            {(["thread", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={scope === value}
                aria-label={
                  value === "thread"
                    ? "Show artifacts from this chat"
                    : "Show all artifacts"
                }
                title={
                  value === "thread"
                    ? "Show artifacts from this chat"
                    : "Show all artifacts"
                }
                className={cn(
                  "min-w-0 flex-1 rounded-md px-2 py-1 text-xs",
                  scope === value
                    ? "bg-kumo-tint text-kumo-strong"
                    : "text-kumo-subtle hover:bg-kumo-base",
                )}
                onClick={() => setScope(value)}
              >
                {value === "thread" ? "This chat" : "All files"}
              </button>
            ))}
          </div>
          <Button
            size="xs"
            variant="ghost"
            shape="square"
            icon={PlusIcon}
            aria-label="Upload artifact"
            disabled={busy}
            onClick={() => uploadInput.current?.click()}
          />
          <input
            ref={uploadInput}
            hidden
            type="file"
            accept=".md,.markdown,.html,.htm,.pdf,.csv,.xlsx,.pptx"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void addArtifact(file);
            }}
          />
        </div>
        <div className="relative p-2">
          <Input
            size="sm"
            value={query}
            aria-label="Search artifacts"
            placeholder="Search"
            className="w-full pe-7"
            onChange={(event) => setQuery(event.target.value)}
          />
          <MagnifyingGlassIcon className="pointer-events-none absolute end-4 top-1/2 size-3.5 -translate-y-1/2 text-kumo-subtle" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="flex justify-center py-8 text-kumo-subtle">
              <Loader size={18} />
            </div>
          ) : artifacts.length === 0 ? (
            <div className="px-2 py-8 text-center">
              <FileIcon className="mx-auto mb-2 size-5 text-kumo-subtle" />
              <p className="text-xs text-kumo-subtle">
                {error ?? (scope === "thread" ? "No artifacts in this chat." : "No artifacts yet.")}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {artifacts.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-start",
                      selectedId === entry.id
                        ? "bg-kumo-tint text-kumo-strong"
                        : "hover:bg-kumo-base",
                    )}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <span className="w-full truncate text-xs font-medium">{entry.title}</span>
                    <span className="w-full truncate text-[11px] text-kumo-subtle">
                      {entry.kind} · r{entry.currentVersion.ordinal}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col">
        {detailLoading ? (
          <div className="flex flex-1 items-center justify-center text-kumo-subtle">
            <Loader size={20} />
          </div>
        ) : artifact === null || selectedVersion === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <FileArrowUpIcon className="size-6 text-kumo-subtle" />
            {detailError !== null ? (
              <>
                <p className="text-sm font-medium">Could not open this artifact</p>
                <p role="alert" className="max-w-xs text-xs text-kumo-danger">
                  {detailError}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const retryId = selectedId;
                    setSelectedId(null);
                    queueMicrotask(() => setSelectedId(retryId));
                  }}
                >
                  <ArrowClockwiseIcon />
                  Try again
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Artifacts live here</p>
                <p className="max-w-xs text-xs text-kumo-subtle">
                  Upload a document, or ask Ruth to create one. Revisions, drafts, comments,
                  and shares stay attached to the artifact.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => uploadInput.current?.click()}
                >
                  <PlusIcon />
                  Upload artifact
                </Button>
              </>
            )}
          </div>
        ) : (
          <>
            <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-kumo-hairline p-3">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium">{artifact.title}</h3>
                <p className="truncate text-[11px] text-kumo-subtle">
                  {selectedVersion.filename} · {formatBytes(selectedVersion.sizeBytes)} ·
                  revision {selectedVersion.ordinal}
                </p>
              </div>
              {editingCurrent && (
                <div role="tablist" aria-label="Artifact view" className="flex gap-1">
                  {(["preview", "edit"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={viewMode === value}
                      className={cn(
                        "rounded-md px-2 py-1 text-xs capitalize",
                        viewMode === value
                          ? "bg-kumo-tint text-kumo-strong"
                          : "text-kumo-subtle hover:bg-kumo-base",
                      )}
                      onClick={() => setViewMode(value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              )}
              <Button
                size="xs"
                variant="ghost"
                shape="square"
                icon={DownloadSimpleIcon}
                aria-label="Download this revision"
                onClick={() => window.open(`${contentUrl}&download=1`, "_blank", "noopener")}
              />
              <Button
                size="xs"
                variant="ghost"
                shape="square"
                icon={LinkIcon}
                aria-label="Share this revision for seven days"
                disabled={busy}
                onClick={() => void share()}
              />
              {editingCurrent ? (
                <Button
                  size="xs"
                  variant="primary"
                  disabled={busy || editorText === savedText}
                  onClick={() => void saveTextRevision()}
                >
                  <FloppyDiskIcon />
                  Save revision
                </Button>
              ) : (
                <>
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => revisionInput.current?.click()}
                  >
                    <FileArrowUpIcon />
                    New revision
                  </Button>
                  <input
                    ref={revisionInput}
                    hidden
                    type="file"
                    accept=".pdf,.csv,.xlsx,.pptx,.md,.markdown,.html,.htm"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void addRevision(file);
                    }}
                  />
                </>
              )}
            </header>
            {shareUrl !== null && (
              <div className="border-b border-kumo-hairline bg-kumo-tint px-3 py-2 text-xs">
                Share copied · expires in 7 days ·{" "}
                <a href={shareUrl} target="_blank" rel="noreferrer" className="underline">
                  open link
                </a>
              </div>
            )}
            {error !== null && (
              <div role="alert" className="border-b border-kumo-hairline px-3 py-2 text-xs text-kumo-danger">
                {error}
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              {editingCurrent && viewMode === "edit" ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <textarea
                    value={editorText}
                    aria-label={`Edit ${artifact.title}`}
                    spellCheck={artifact.kind === "markdown"}
                    className="min-h-0 flex-1 resize-none bg-kumo-canvas p-4 font-mono text-sm leading-6 outline-none"
                    onChange={(event) => setEditorText(event.target.value)}
                    onSelect={(event) => {
                      const target = event.currentTarget;
                      if (target.selectionStart !== target.selectionEnd) {
                        setSelection({
                          type: "text",
                          start: target.selectionStart,
                          end: target.selectionEnd,
                          text: target.value.slice(target.selectionStart, target.selectionEnd),
                        });
                      }
                    }}
                  />
                  <p className="shrink-0 border-t border-kumo-hairline px-3 py-1.5 text-[11px] text-kumo-subtle">
                    {draftStatus === "saving"
                      ? "Saving draft…"
                      : draftStatus === "saved"
                        ? "Draft saved"
                        : draftStatus === "error"
                          ? "Draft could not be saved"
                          : "Save revision creates an immutable version"}
                  </p>
                </div>
              ) : (
                <ArtifactPreview
                  key={contentUrl}
                  kind={artifact.kind}
                  filename={selectedVersion.filename}
                  mimeType={artifact.mimeType}
                  contentUrl={contentUrl}
                  {...(editingCurrent ? { text: editorText } : {})}
                  onSelection={setSelection}
                />
              )}
            </div>
            <details className="shrink-0 border-t border-kumo-hairline">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-kumo-base [&::-webkit-details-marker]:hidden">
                <NotePencilIcon />
                Comments and history
                <Badge variant="secondary" className="ms-auto">
                  {detail?.comments.length ?? 0} comments · {detail?.versions.length ?? 0} revisions
                </Badge>
              </summary>
              <div className="grid max-h-64 grid-cols-2 gap-3 overflow-y-auto border-t border-kumo-hairline p-3">
                <div className="flex min-w-0 flex-col gap-2">
                  {selection !== null && (
                    <div className="flex items-center gap-1 rounded-md bg-kumo-tint px-2 py-1 text-[11px]">
                      <span className="truncate">{selectionLabel(selection) ?? "Selection"}</span>
                      <button
                        type="button"
                        className="ms-auto text-kumo-subtle"
                        onClick={() => setSelection(null)}
                      >
                        clear
                      </button>
                    </div>
                  )}
                  <textarea
                    value={comment}
                    aria-label="Comment on this revision"
                    placeholder="Comment on this revision…"
                    rows={3}
                    className="w-full resize-none rounded-md bg-kumo-base p-2 text-xs ring ring-kumo-hairline outline-none focus:ring-kumo-focus"
                    onChange={(event) => setComment(event.target.value)}
                  />
                  <Button
                    size="xs"
                    variant="secondary"
                    className="self-end"
                    disabled={busy || !comment.trim()}
                    onClick={() => void addComment()}
                  >
                    Add comment
                  </Button>
                  <ul className="flex flex-col gap-2">
                    {(detail?.comments ?? [])
                      .filter((entry) => entry.versionId === selectedVersion.id)
                      .map((entry) => (
                        <li key={entry.id} className="rounded-md bg-kumo-base p-2 text-xs">
                          <p>{entry.body}</p>
                          <p className="mt-1 text-[10px] text-kumo-subtle">
                            {selectionLabel(entry.selection) ?? "Whole revision"} ·{" "}
                            {relativeDate(entry.createdAt)}
                          </p>
                        </li>
                      ))}
                  </ul>
                  {shares.length > 0 && (
                    <div className="border-t border-kumo-hairline pt-2">
                      <p className="mb-1 text-[10px] font-medium tracking-wide text-kumo-subtle uppercase">
                        Public shares
                      </p>
                      <ul className="flex flex-col gap-1">
                        {shares.map((entry) => {
                          const inactive =
                            entry.revokedAt !== null ||
                            new Date(entry.expiresAt).getTime() <= Date.now();
                          return (
                            <li
                              key={entry.id}
                              className="flex items-center gap-2 rounded-md bg-kumo-base px-2 py-1 text-[11px]"
                            >
                              <span className="min-w-0 flex-1 truncate">
                                r
                                {detail?.versions.find(
                                  (version) => version.id === entry.versionId,
                                )?.ordinal ?? "?"}{" "}
                                ·{" "}
                                {inactive
                                  ? "inactive"
                                  : `expires ${new Date(entry.expiresAt).toLocaleDateString()}`}
                              </span>
                              {!inactive && (
                                <button
                                  type="button"
                                  className="text-kumo-danger hover:underline"
                                  disabled={busy}
                                  onClick={() => void revokeShare(entry.id)}
                                >
                                  Revoke
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
                <ol className="flex min-w-0 flex-col gap-1">
                  {(detail?.versions ?? []).map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs",
                          selectedVersion.id === entry.id
                            ? "bg-kumo-tint text-kumo-strong"
                            : "hover:bg-kumo-base",
                        )}
                        onClick={() => {
                          setSelectedVersionId(entry.id);
                          setSelection(null);
                          setViewMode("preview");
                        }}
                      >
                        <ClockCounterClockwiseIcon className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          r{entry.ordinal} · {entry.changeSummary ?? entry.createdFrom}
                        </span>
                        <span className="text-[10px] text-kumo-subtle">
                          {relativeDate(entry.createdAt)}
                        </span>
                      </button>
                      {entry.id !== artifact.currentVersionId && selectedVersion.id === entry.id && (
                        <Button
                          size="xs"
                          variant="ghost"
                          className="ms-6"
                          disabled={busy}
                          onClick={() => void restore(entry.id)}
                        >
                          <ArrowClockwiseIcon />
                          Restore as new revision
                        </Button>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          </>
        )}
      </section>
    </div>
  );
}
