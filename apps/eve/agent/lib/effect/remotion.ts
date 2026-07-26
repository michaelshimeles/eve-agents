import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Context, Data, Effect, Layer, Schema } from "effect";

// Programmatic video rendering with Remotion as an Effect service. The model
// authors a React component (TSX source); we wrap it in a generated Remotion
// project, bundle it with webpack, render it to MP4 in headless Chrome, and
// store the file (Vercel Blob when a token is configured, otherwise a local
// directory served by /api/videos/[file]).
//
// The scratch/render directories live inside the app dir (not os.tmpdir) so
// the generated entry can resolve `remotion` and `react` from the workspace's
// node_modules. Local storage suits dev / a long-lived server; on serverless
// hosting, rendering should move to @remotion/lambda instead.

export class VideoRenderError extends Data.TaggedError("VideoRenderError")<{
  readonly stage: "bundle" | "render" | "store";
  readonly cause: unknown;
}> {}

export function describeVideoRenderError(error: VideoRenderError): string {
  const detail = error.cause instanceof Error ? error.cause.message : String(error.cause);
  const hint =
    error.stage === "bundle"
      ? "The component source likely failed to compile - fix the TSX and retry."
      : error.stage === "render"
        ? "The composition crashed while rendering - check the component for runtime errors."
        : "The video rendered but could not be stored.";
  return `Video ${error.stage} failed: ${detail} ${hint}`;
}

const REMOTION_DIR = () => path.join(process.cwd(), ".remotion");
export const RENDERS_DIR = () => path.join(REMOTION_DIR(), "renders");

export const RenderVideoInput = Schema.Struct({
  component_tsx: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)).annotate({
    description:
      "TSX source of a file that default-exports the React component to render. May import only from \"react\" and \"remotion\".",
  }),
  duration_in_frames: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })).annotate({
    description: "Total length in frames (duration_in_frames / fps = seconds).",
  }),
  fps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 }))
    .annotate({ description: "Frames per second, default 30." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(30))),
  width: Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 3840 }))
    .annotate({ description: "Video width in pixels, default 1920." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(1920))),
  height: Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 3840 }))
    .annotate({ description: "Video height in pixels, default 1080." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(1080))),
  file_name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,60}$/))
    .annotate({
      description: "Base name for the .mp4 file (lowercase letters, digits, - and _).",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed("video"))),
});
export type RenderVideoInput = typeof RenderVideoInput.Type;

export interface RenderedVideo {
  readonly url: string;
  readonly file_name: string;
  readonly size_bytes: number;
  readonly storage: "blob" | "local";
  readonly duration_in_frames: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly duration_seconds: number;
}

export class Remotion extends Context.Service<Remotion, {
  readonly render: (input: RenderVideoInput) => Effect.Effect<RenderedVideo, VideoRenderError>;
}>()("Remotion") {}

function rootTsx(input: RenderVideoInput): string {
  return `import { Composition } from "remotion";
import Component from "./component";

export const Root = () => (
  <Composition
    id="main"
    component={Component}
    durationInFrames={${input.duration_in_frames}}
    fps={${input.fps}}
    width={${input.width}}
    height={${input.height}}
  />
);
`;
}

const INDEX_TS = `import { registerRoot } from "remotion";
import { Root } from "./root";
registerRoot(Root);
`;

function renderVideo(input: RenderVideoInput): Effect.Effect<RenderedVideo, VideoRenderError> {
  const jobId = randomBytes(4).toString("hex");
  const scratch = path.join(REMOTION_DIR(), "jobs", jobId);
  const outputLocation = path.join(scratch, "out.mp4");
  const fileName = `${input.file_name}-${jobId}.mp4`;

  const writeProject = Effect.tryPromise({
    try: async () => {
      await mkdir(scratch, { recursive: true });
      await writeFile(path.join(scratch, "component.tsx"), input.component_tsx);
      await writeFile(path.join(scratch, "root.tsx"), rootTsx(input));
      await writeFile(path.join(scratch, "index.ts"), INDEX_TS);
    },
    catch: (cause) => new VideoRenderError({ stage: "bundle", cause }),
  });

  const bundleProject = Effect.tryPromise({
    try: async () => {
      const { bundle } = await import("@remotion/bundler");
      return await bundle({ entryPoint: path.join(scratch, "index.ts") });
    },
    catch: (cause) => new VideoRenderError({ stage: "bundle", cause }),
  });

  const renderBundle = (serveUrl: string) =>
    Effect.tryPromise({
      try: async () => {
        const { ensureBrowser, renderMedia, selectComposition } = await import(
          "@remotion/renderer"
        );
        await ensureBrowser();
        const composition = await selectComposition({
          serveUrl,
          id: "main",
          logLevel: "error",
        });
        await renderMedia({
          composition,
          serveUrl,
          codec: "h264",
          outputLocation,
          logLevel: "error",
        });
      },
      catch: (cause) => new VideoRenderError({ stage: "render", cause }),
    });

  const store = Effect.tryPromise({
    try: async (): Promise<{ url: string; sizeBytes: number; storage: "blob" | "local" }> => {
      const data = await readFile(outputLocation);
      if (process.env.BLOB_READ_WRITE_TOKEN) {
        const { put } = await import("@vercel/blob");
        const blob = await put(`videos/${fileName}`, data, {
          access: "public",
          contentType: "video/mp4",
        });
        return { url: blob.url, sizeBytes: data.byteLength, storage: "blob" };
      }
      await mkdir(RENDERS_DIR(), { recursive: true });
      await rename(outputLocation, path.join(RENDERS_DIR(), fileName));
      return { url: `/api/videos/${fileName}`, sizeBytes: data.byteLength, storage: "local" };
    },
    catch: (cause) => new VideoRenderError({ stage: "store", cause }),
  });

  const cleanup = Effect.promise(() => rm(scratch, { recursive: true, force: true }).catch(() => undefined));

  return Effect.gen(function* () {
    yield* writeProject;
    const serveUrl = yield* bundleProject;
    yield* renderBundle(serveUrl);
    const stored = yield* store;
    return {
      url: stored.url,
      file_name: fileName,
      size_bytes: stored.sizeBytes,
      storage: stored.storage,
      duration_in_frames: input.duration_in_frames,
      fps: input.fps,
      width: input.width,
      height: input.height,
      duration_seconds: Math.round((input.duration_in_frames / input.fps) * 100) / 100,
    };
  }).pipe(Effect.ensuring(cleanup));
}

export const RemotionLive = Layer.succeed(Remotion, { render: renderVideo });

export const renderVideoEffect = (
  input: RenderVideoInput,
): Effect.Effect<RenderedVideo, VideoRenderError, Remotion> =>
  Effect.gen(function* () {
    return yield* (yield* Remotion).render(input);
  });
