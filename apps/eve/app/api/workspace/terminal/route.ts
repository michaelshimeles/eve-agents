import { experimental_upgradeWebSocket } from "@vercel/functions";

import { openWorkspaceInteractive } from "@/agent/lib/effect/sandbox-workspace";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  authorizeWorkspaceTarget,
  requireWorkspaceRequest,
  workspaceApiFailure,
  workspaceTargetFromUrl,
} from "@/lib/workspace-server";
import { pipeWorkspaceTerminal } from "@/lib/workspace-terminal-relay";

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const authentication = await requireWorkspaceRequest(request, true);
  if (authentication instanceof Response) return authentication;
  try {
    const target = workspaceTargetFromUrl(new URL(request.url));
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    const credentials = await runApp(openWorkspaceInteractive(target));
    return await experimental_upgradeWebSocket((client) =>
      pipeWorkspaceTerminal(client, credentials),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("upgrade")) {
      return new Response("WebSocket upgrades are unavailable in this runtime.", { status: 501 });
    }
    return workspaceApiFailure(error);
  }
}
