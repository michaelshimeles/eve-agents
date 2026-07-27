import path from "node:path";
import { readFile } from "node:fs/promises";

import { Effect, Exit } from "effect";

import { RENDERS_DIR } from "@/agent/lib/effect/remotion";
import { runtime } from "@/agent/lib/effect/runtime";
import { requireWebAuth } from "@/lib/web-auth";

// Serves MP4s rendered by the render_video tool when no Blob token is
// configured (local storage mode). Files live in .remotion/renders inside the
// app directory, so this only works while that filesystem persists — i.e. dev
// or a long-lived server, which is exactly when local mode is active.

const FILE_PATTERN = /^[a-z0-9][a-z0-9_-]*\.mp4$/;

type RouteContext = { params: Promise<{ file: string }> };

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const { file } = await ctx.params;
  if (!FILE_PATTERN.test(file)) return new Response("Not found", { status: 404 });

  const exit = await runtime.runPromiseExit(
    Effect.tryPromise(() => readFile(path.join(RENDERS_DIR(), file))),
  );
  if (Exit.isFailure(exit)) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(exit.value), {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(exit.value.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
