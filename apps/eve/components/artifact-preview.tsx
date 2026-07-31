"use client";

import { Button, LinkButton, Loader } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

import type { ArtifactKind } from "@/agent/lib/effect/artifacts";
import { Markdown } from "@/components/markdown";

const SpreadsheetPreview = dynamic(
  () =>
    import("@/components/spreadsheet-preview").then((module) => module.SpreadsheetPreview),
  {
    ssr: false,
    loading: () => <PreviewLoading />,
  },
);

const PresentationPreview = dynamic(
  () =>
    import("@/components/presentation-preview").then(
      (module) => module.PresentationPreview,
    ),
  {
    ssr: false,
    loading: () => <PreviewLoading />,
  },
);

function PreviewLoading() {
  return (
    <div className="flex min-h-64 flex-1 items-center justify-center text-kumo-subtle">
      <Loader size={20} />
    </div>
  );
}

function htmlDocument(content: string): string {
  const policy =
    "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
  const csp = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  return /<head[\s>]/i.test(content)
    ? content.replace(/<head([^>]*)>/i, `<head$1>${csp}`)
    : `<!doctype html><html><head>${csp}</head><body>${content}</body></html>`;
}

export function ArtifactPreview({
  kind,
  filename,
  mimeType,
  contentUrl,
  text,
  onSelection,
}: {
  kind: ArtifactKind;
  filename: string;
  mimeType: string;
  contentUrl: string;
  text?: string;
  onSelection?: (selection: unknown) => void;
}) {
  const [loadedText, setLoadedText] = useState<string | null>(text ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (text !== undefined) {
      setLoadedText(text);
      return;
    }
    if (kind !== "markdown" && kind !== "html") return;
    let cancelled = false;
    void fetch(contentUrl)
      .then((response) => {
        if (!response.ok) throw new Error("Could not load artifact content.");
        return response.text();
      })
      .then((content) => {
        if (!cancelled) setLoadedText(content);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not load artifact content.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contentUrl, kind, text]);

  const safeHtml = useMemo(
    () => (loadedText === null ? null : htmlDocument(loadedText)),
    [loadedText],
  );

  if (error !== null) return <p className="p-4 text-sm text-kumo-danger">{error}</p>;
  if (kind === "markdown") {
    return loadedText === null ? (
      <PreviewLoading />
    ) : (
      <article className="min-h-0 flex-1 overflow-auto p-5">
        <Markdown>{loadedText}</Markdown>
      </article>
    );
  }
  if (kind === "html") {
    return safeHtml === null ? (
      <PreviewLoading />
    ) : (
      <iframe
        title={`Preview of ${filename}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={safeHtml}
        className="min-h-0 flex-1 bg-white"
      />
    );
  }
  if (kind === "pdf") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <iframe
          title={`Preview of ${filename}`}
          src={`${contentUrl}#view=FitH`}
          className="min-h-0 flex-1 bg-white"
        />
        <div className="flex shrink-0 items-center gap-2 border-t border-kumo-hairline p-2">
          <span className="text-xs text-kumo-subtle">
            Select a page in the PDF viewer, then mention the page in your comment.
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="ms-auto"
            onClick={() => onSelection?.({ type: "page", page: "current" })}
          >
            Mark current page
          </Button>
        </div>
      </div>
    );
  }
  if (kind === "spreadsheet") {
    return (
      <SpreadsheetPreview
        contentUrl={contentUrl}
        filename={filename}
        onSelection={onSelection}
      />
    );
  }
  if (kind === "presentation") {
    return <PresentationPreview contentUrl={contentUrl} onSelection={onSelection} />;
  }
  const downloadUrl = `${contentUrl}${contentUrl.includes("?") ? "&" : "?"}download=1`;
  return (
    <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium">{filename}</p>
      <p className="text-xs text-kumo-subtle">{mimeType}</p>
      <div className="flex gap-2">
        <LinkButton href={contentUrl} target="_blank" external variant="secondary" size="sm">
          <ArrowSquareOutIcon />
          Open
        </LinkButton>
        <LinkButton href={downloadUrl} variant="primary" size="sm">
          <DownloadSimpleIcon />
          Download
        </LinkButton>
      </div>
    </div>
  );
}
