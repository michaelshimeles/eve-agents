import { experimental_upgradeWebSocket } from "@vercel/functions";

import { openWorkspaceUpload } from "@/agent/lib/effect/sandbox-workspace";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  authorizeWorkspaceTarget,
  requireWorkspaceRequest,
  workspaceApiFailure,
  workspaceTargetFromUrl,
} from "@/lib/workspace-server";
import { serveWorkspaceUpload } from "@/lib/workspace-transfer";

export const maxDuration = 800;

export async function GET(request: Request): Promise<Response> {
  const authentication = requireWorkspaceRequest(request, true);
  if (authentication instanceof Response) return authentication;
  try {
    const url = new URL(request.url);
    const target = workspaceTargetFromUrl(url);
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    const path = url.searchParams.get("path");
    const size = Number(url.searchParams.get("size"));
    if (path === null || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("A valid upload path and size are required.");
    }
    const upload = await runApp(
      openWorkspaceUpload(target, {
        path,
        size,
        overwrite: url.searchParams.get("overwrite") === "1",
      }),
    );
    return await experimental_upgradeWebSocket((client) =>
      serveWorkspaceUpload(client, upload, size),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("upgrade")) {
      return new Response("WebSocket upgrades are unavailable in this runtime.", { status: 501 });
    }
    return workspaceApiFailure(error);
  }
}
