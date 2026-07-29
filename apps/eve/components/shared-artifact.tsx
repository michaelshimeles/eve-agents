"use client";

import { LinkButton } from "@cloudflare/kumo";
import { DownloadSimpleIcon } from "@phosphor-icons/react";

import type { ArtifactDescriptor, ArtifactVersion } from "@/agent/lib/effect/artifacts";
import { ArtifactPreview } from "@/components/artifact-preview";

export function SharedArtifact({
  artifact,
  version,
  token,
}: {
  artifact: ArtifactDescriptor;
  version: ArtifactVersion;
  token: string;
}) {
  const contentUrl = `/api/shared/${encodeURIComponent(token)}/content`;
  return (
    <main className="flex h-dvh flex-col bg-kumo-canvas">
      <header className="flex shrink-0 items-center gap-3 border-b border-kumo-hairline bg-kumo-elevated px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{artifact.title}</h1>
          <p className="truncate text-xs text-kumo-subtle">
            {version.filename} · revision {version.ordinal} · shared read-only
          </p>
        </div>
        <LinkButton href={`${contentUrl}?download=1`} size="sm" variant="primary">
          <DownloadSimpleIcon />
          Download
        </LinkButton>
      </header>
      <div className="flex min-h-0 flex-1">
        <ArtifactPreview
          kind={artifact.kind}
          filename={version.filename}
          mimeType={artifact.mimeType}
          contentUrl={contentUrl}
        />
      </div>
    </main>
  );
}
