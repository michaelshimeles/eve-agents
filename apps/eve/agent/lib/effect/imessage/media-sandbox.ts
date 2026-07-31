import { Sandbox } from "@vercel/sandbox";
import { Data, Effect } from "effect";

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 100;
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_FRAMES = 8;

export class IMessageSandboxMediaError extends Data.TaggedError(
  "IMessageSandboxMediaError",
)<{
  readonly operation: "video" | "document";
  readonly detail: string;
}> {}

export interface VideoExtraction {
  readonly durationSeconds: number;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly frames: readonly {
    readonly second: number;
    readonly jpeg: Uint8Array;
  }[];
  readonly audio?: Uint8Array;
}

function safeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop()?.replace(/[^A-Za-z0-9._-]/g, "_") ?? "";
  return base.length > 0 ? base.slice(0, 120) : fallback;
}

function parseJson<T>(value: string, operation: "video" | "document"): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new IMessageSandboxMediaError({
      operation,
      detail: "sandbox returned malformed inspection metadata",
    });
  }
}

/**
 * Probes video, extracts at most eight representative JPEGs, and extracts one
 * bounded audio track. The sandbox has no network and is always stopped.
 */
export function extractIMessageVideo(input: {
  readonly bytes: Uint8Array;
  readonly name: string;
}): Effect.Effect<VideoExtraction, IMessageSandboxMediaError> {
  return Effect.tryPromise({
    try: async () => {
      if (input.bytes.byteLength > MAX_INPUT_BYTES) {
        throw new Error("video exceeds the 100 MiB provider ceiling");
      }
      const sandbox = await Sandbox.create({
        runtime: "node24",
        timeout: 5 * 60_000,
        networkPolicy: "deny-all",
        resources: { vcpus: 2 },
        tags: { capability: "imessage-media" },
      });
      try {
        const name = safeFileName(input.name, "video.bin");
        const path = `/vercel/sandbox/${name}`;
        await sandbox.writeFiles([{ path, content: input.bytes }]);
        const probe = await sandbox.runCommand(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name",
            "-of",
            "json",
            path,
          ],
          { timeoutMs: 30_000 },
        );
        if (probe.exitCode !== 0) {
          throw new Error(`ffprobe failed: ${(await probe.stderr()).slice(0, 300)}`);
        }
        const metadata = parseJson<{
          format?: { duration?: string };
          streams?: readonly { codec_type?: string; codec_name?: string }[];
        }>(await probe.stdout(), "video");
        const durationSeconds = Number(metadata.format?.duration ?? 0);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          throw new Error("video duration is unavailable");
        }
        const frameCount = Math.min(
          MAX_VIDEO_FRAMES,
          Math.max(1, Math.ceil(durationSeconds / 15)),
        );
        const seconds = Array.from(
          { length: frameCount },
          (_, index) => ((index + 1) * durationSeconds) / (frameCount + 1),
        );
        const frames = [];
        for (const [index, second] of seconds.entries()) {
          const framePath = `/vercel/sandbox/frame-${index}.jpg`;
          const result = await sandbox.runCommand(
            "ffmpeg",
            [
              "-v",
              "error",
              "-ss",
              second.toFixed(3),
              "-i",
              path,
              "-frames:v",
              "1",
              "-vf",
              "scale='min(1600,iw)':-2",
              "-q:v",
              "3",
              "-y",
              framePath,
            ],
            { timeoutMs: 45_000 },
          );
          if (result.exitCode !== 0) continue;
          const jpeg = await sandbox.readFileToBuffer({ path: framePath });
          if (jpeg !== null && jpeg.byteLength <= 8 * 1024 * 1024) {
            frames.push({ second, jpeg: new Uint8Array(jpeg) });
          }
        }
        const audioPath = "/vercel/sandbox/audio.mp3";
        const audioResult = await sandbox.runCommand(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            path,
            "-vn",
            "-ac",
            "1",
            "-b:a",
            "64k",
            "-y",
            audioPath,
          ],
          { timeoutMs: 90_000 },
        );
        const audio =
          audioResult.exitCode === 0
            ? await sandbox.readFileToBuffer({ path: audioPath })
            : null;
        return {
          durationSeconds,
          videoCodec: metadata.streams?.find((stream) => stream.codec_type === "video")
            ?.codec_name,
          audioCodec: metadata.streams?.find((stream) => stream.codec_type === "audio")
            ?.codec_name,
          frames,
          ...(audio === null ? {} : { audio: new Uint8Array(audio) }),
        };
      } finally {
        await sandbox.stop();
      }
    },
    catch: (cause) =>
      cause instanceof IMessageSandboxMediaError
        ? cause
        : new IMessageSandboxMediaError({
            operation: "video",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
  });
}

/**
 * Extracts a supported archive after rejecting absolute paths, traversal,
 * symlinks, excessive file counts, and excessive expanded bytes.
 */
export function inspectIMessageArchive(input: {
  readonly bytes: Uint8Array;
  readonly name: string;
}): Effect.Effect<
  {
    readonly files: readonly { readonly path: string; readonly size: number }[];
    readonly extractedText?: string;
  },
  IMessageSandboxMediaError
> {
  return Effect.tryPromise({
    try: async () => {
      if (input.bytes.byteLength > MAX_INPUT_BYTES) {
        throw new Error("archive exceeds the 100 MiB provider ceiling");
      }
      const sandbox = await Sandbox.create({
        runtime: "node24",
        timeout: 3 * 60_000,
        networkPolicy: "deny-all",
        resources: { vcpus: 1 },
        tags: { capability: "imessage-media" },
      });
      try {
        const path = `/vercel/sandbox/${safeFileName(input.name, "archive.zip")}`;
        await sandbox.writeFiles([{ path, content: input.bytes }]);
        const list = await sandbox.runCommand(
          "unzip",
          ["-Z", "-v", path],
          { timeoutMs: 30_000 },
        );
        if (list.exitCode !== 0) throw new Error("unsupported or corrupt archive");
        const compact = await sandbox.runCommand(
          "unzip",
          ["-Z", "-1", path],
          { timeoutMs: 30_000 },
        );
        const names = (await compact.stdout())
          .split("\n")
          .map((name) => name.trim())
          .filter(Boolean);
        if (names.length > MAX_ARCHIVE_FILES) throw new Error("archive has too many files");
        if (
          names.some(
            (name) =>
              name.startsWith("/") ||
              name.includes("\\") ||
              name.split("/").some((part) => part === ".."),
          )
        ) {
          throw new Error("archive contains an unsafe path");
        }
        const extract = await sandbox.runCommand(
          "unzip",
          ["-qq", path, "-d", "/vercel/sandbox/extracted"],
          { timeoutMs: 60_000 },
        );
        if (extract.exitCode !== 0) throw new Error("archive extraction failed");
        const sizes = await sandbox.runCommand(
          "find",
          [
            "/vercel/sandbox/extracted",
            "-type",
            "f",
            "-printf",
            "%P\\t%s\\n",
          ],
          { timeoutMs: 30_000 },
        );
        const files = (await sizes.stdout())
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [pathValue = "", sizeValue = "0"] = line.split("\t");
            return { path: pathValue, size: Number(sizeValue) };
          });
        const total = files.reduce((sum, file) => sum + file.size, 0);
        if (total > MAX_EXTRACTED_BYTES) throw new Error("expanded archive is too large");
        const extension = input.name.toLowerCase().split(".").pop();
        const textEntries =
          extension === "docx"
            ? names.filter((name) => name === "word/document.xml")
            : extension === "pptx"
              ? names
                  .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
                  .slice(0, 100)
              : extension === "xlsx"
                ? names
                    .filter(
                      (name) =>
                        name === "xl/sharedStrings.xml" ||
                        /^xl\/worksheets\/sheet\d+\.xml$/u.test(name),
                    )
                    .slice(0, 101)
                : [];
        let extractedText: string | undefined;
        if (textEntries.length > 0) {
          const extracted = await sandbox.runCommand(
            "unzip",
            ["-p", path, ...textEntries],
            { timeoutMs: 30_000 },
          );
          if (extracted.exitCode === 0) {
            extractedText = (await extracted.stdout())
              .replace(/<[^>]+>/gu, " ")
              .replace(/&amp;/gu, "&")
              .replace(/&lt;/gu, "<")
              .replace(/&gt;/gu, ">")
              .replace(/\s+/gu, " ")
              .trim()
              .slice(0, 100_000);
          }
        }
        return {
          files,
          ...(extractedText === undefined || extractedText.length === 0
            ? {}
            : { extractedText }),
        };
      } finally {
        await sandbox.stop();
      }
    },
    catch: (cause) =>
      cause instanceof IMessageSandboxMediaError
        ? cause
        : new IMessageSandboxMediaError({
            operation: "document",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
  });
}
