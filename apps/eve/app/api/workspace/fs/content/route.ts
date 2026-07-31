import { basename, extname } from "node:path";
import { Readable } from "node:stream";

import {
  readWorkspaceFile,
  readWorkspaceText,
  writeWorkspaceText,
} from "@/agent/lib/effect/sandbox-workspace";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  authorizeWorkspaceTarget,
  requireWorkspaceRequest,
  workspaceApiFailure,
  workspaceTargetFromBody,
  workspaceTargetFromUrl,
} from "@/lib/workspace-server";

const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

const ACTIVE_EXTENSIONS = new Set([".html", ".htm", ".svg", ".xml", ".xhtml"]);

function safeFilename(path: string): string {
  return basename(path).replace(/[\r\n"\\]/g, "_") || "workspace-file";
}

export async function GET(request: Request): Promise<Response> {
  const authentication = requireWorkspaceRequest(request);
  if (authentication instanceof Response) return authentication;
  try {
    const url = new URL(request.url);
    const target = workspaceTargetFromUrl(url);
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    const path = url.searchParams.get("path");
    if (path === null) throw new Error("A file path is required.");
    if (url.searchParams.get("mode") === "text") {
      return Response.json(await runApp(readWorkspaceText(target, path)));
    }
    const file = await runApp(readWorkspaceFile(target, path));
    const extension = extname(file.path).toLowerCase();
    const download =
      url.searchParams.get("download") === "1" || ACTIVE_EXTENSIONS.has(extension);
    const headers = new Headers({
      "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "Content-Length": String(file.size),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeFilename(file.path)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    return new Response(Readable.toWeb(file.stream as Readable) as ReadableStream, { headers });
  } catch (error) {
    return workspaceApiFailure(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const authentication = requireWorkspaceRequest(request, true);
  if (authentication instanceof Response) return authentication;
  const body = (await request.json().catch(() => null)) as
    | ({
        path?: string;
        content?: string;
        expectedVersion?: string;
      } & Record<string, unknown>)
    | null;
  try {
    if (body === null || typeof body.path !== "string" || typeof body.content !== "string") {
      throw new Error("A file path and text content are required.");
    }
    const target = workspaceTargetFromBody(body);
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    const file = await runApp(
      writeWorkspaceText(target, {
        path: body.path,
        content: body.content,
        ...(typeof body.expectedVersion === "string"
          ? { expectedVersion: body.expectedVersion }
          : {}),
      }),
    );
    return Response.json(file);
  } catch (error) {
    return workspaceApiFailure(error);
  }
}
