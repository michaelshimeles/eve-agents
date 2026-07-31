"use client";

import { Button, Input, Loader } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  DownloadSimpleIcon,
  FileIcon,
  FileImageIcon,
  FilePdfIcon,
  FilesIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  SidebarSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";

import type { ChatFileView } from "@/lib/files-api";
import { formatBytes } from "@/lib/voice/attachments";

function iconFor(file: ChatFileView) {
  if (file.mediaType.startsWith("image/")) return FileImageIcon;
  if (file.mediaType === "application/pdf") return FilePdfIcon;
  if (file.mediaType.startsWith("text/")) return FileTextIcon;
  return FileIcon;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function FilesPage({
  onOpenSidebar,
  onBack,
  onOpenThread,
}: {
  onOpenSidebar: () => void;
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [files, setFiles] = useState<ChatFileView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  function loadFiles() {
    setError(null);
    void fetch("/api/files")
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          files?: ChatFileView[];
          error?: string;
        } | null;
        if (!response.ok)
          throw new Error(body?.error ?? "Could not load files.");
        setFiles(body?.files ?? []);
      })
      .catch((cause: unknown) => {
        setFiles([]);
        setError(
          cause instanceof Error ? cause.message : "Could not load files.",
        );
      });
  }

  useEffect(loadFiles, []);

  const visibleFiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return files ?? [];
    return (files ?? []).filter(
      (file) =>
        file.filename.toLowerCase().includes(needle) ||
        file.mediaType.toLowerCase().includes(needle) ||
        file.threadTitle?.toLowerCase().includes(needle),
    );
  }, [files, query]);

  return (
    <main className="flex h-dvh min-w-0 flex-1 flex-col bg-kumo-canvas">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-kumo-hairline px-4">
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={SidebarSimpleIcon}
          aria-label="Open sidebar"
          className="md:hidden"
          onClick={onOpenSidebar}
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-kumo-strong">
            Files
          </h1>
          <p className="truncate text-xs text-kumo-subtle">
            Every file uploaded in chat
          </p>
        </div>
        <p className="shrink-0 text-xs tabular-nums text-kumo-subtle">
          {files === null
            ? ""
            : `${files.length} ${files.length === 1 ? "file" : "files"}`}
        </p>
      </header>

      <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-4 py-6 sm:px-6">
        <div className="relative mb-5 w-full max-w-sm">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-kumo-subtle"
            aria-hidden
          />
          <Input
            size="sm"
            value={query}
            placeholder="Search files"
            aria-label="Search files"
            className="w-full ps-8 pe-8 ring-kumo-hairline"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query.length > 0 && (
            <button
              type="button"
              aria-label="Clear file search"
              className="absolute end-2 top-1/2 -translate-y-1/2 text-kumo-subtle hover:text-kumo-default"
              onClick={() => setQuery("")}
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>

        {error !== null && (
          <div className="mb-5 flex items-start justify-between gap-4 rounded-lg bg-kumo-danger-tint px-3 py-2.5 text-sm text-kumo-danger ring ring-kumo-danger/30">
            <p className="text-pretty">{error}</p>
            <Button variant="ghost" size="xs" onClick={loadFiles}>
              Retry
            </Button>
          </div>
        )}

        {files === null ? (
          <div className="flex flex-1 items-center justify-center text-kumo-subtle">
            <Loader size={20} />
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[10vh] text-center">
            <span className="mb-4 flex size-11 items-center justify-center rounded-xl bg-kumo-tint text-kumo-default">
              <FilesIcon className="size-5" aria-hidden />
            </span>
            <h2 className="text-balance text-base font-semibold text-kumo-strong">
              {query.length > 0 ? "No matching files" : "No files yet"}
            </h2>
            <p className="mt-1 max-w-sm text-pretty text-sm text-kumo-subtle">
              {query.length > 0
                ? "Try a different filename, file type, or conversation."
                : "Attach an image or file to a chat message and it will appear here."}
            </p>
            <Button
              className="mt-4"
              size="sm"
              onClick={query.length > 0 ? () => setQuery("") : onBack}
            >
              {query.length > 0 ? "Clear search" : "Go to chat"}
            </Button>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 pb-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleFiles.map((file, index) => {
              const Icon = iconFor(file);
              const image = file.mediaType.startsWith("image/");
              return (
                <li
                  key={file.id}
                  className="group overflow-hidden rounded-xl bg-kumo-base ring ring-kumo-hairline"
                >
                  <a
                    href={file.contentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="relative flex aspect-4/3 items-center justify-center overflow-hidden bg-kumo-tint outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus"
                    aria-label={`Open ${file.filename}`}
                  >
                    {image ? (
                      <Image
                        src={file.contentUrl}
                        alt={file.filename}
                        fill
                        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                        unoptimized
                        loading={index < 4 ? "eager" : "lazy"}
                        className="size-full object-cover"
                      />
                    ) : (
                      <Icon className="size-10 text-kumo-subtle" aria-hidden />
                    )}
                    <span className="absolute end-2 top-2 flex size-7 items-center justify-center rounded-md bg-kumo-base text-kumo-subtle opacity-0 shadow-sm ring ring-kumo-hairline group-hover:opacity-100 group-focus-within:opacity-100">
                      <ArrowSquareOutIcon className="size-3.5" aria-hidden />
                    </span>
                  </a>
                  <div className="p-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p
                          className="truncate text-sm font-medium text-kumo-strong"
                          title={file.filename}
                        >
                          {file.filename}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-kumo-subtle">
                          {formatBytes(file.sizeBytes)} ·{" "}
                          {dateLabel(file.createdAt)}
                        </p>
                      </div>
                      <a
                        href={file.downloadUrl}
                        aria-label={`Download ${file.filename}`}
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
                      >
                        <DownloadSimpleIcon className="size-4" aria-hidden />
                      </a>
                    </div>
                    <button
                      type="button"
                      className="mt-2 max-w-full truncate text-left text-xs text-kumo-subtle hover:text-kumo-default"
                      title={
                        file.threadTitle ??
                        "Open the conversation where this was uploaded"
                      }
                      onClick={() => onOpenThread(file.threadId)}
                    >
                      {file.threadTitle === null
                        ? "Open conversation"
                        : `From ${file.threadTitle}`}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
