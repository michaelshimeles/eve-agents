import {
  decodeWorkspaceFsAction,
  listWorkspaceDirectory,
  mutateWorkspaceFs,
} from "@/agent/lib/effect/sandbox-workspace";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  authorizeWorkspaceTarget,
  requireWorkspaceRequest,
  workspaceApiFailure,
  workspaceTargetFromBody,
  workspaceTargetFromUrl,
} from "@/lib/workspace-server";

export async function GET(request: Request): Promise<Response> {
  const authentication = requireWorkspaceRequest(request);
  if (authentication instanceof Response) return authentication;
  try {
    const url = new URL(request.url);
    const target = workspaceTargetFromUrl(url);
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    const path = url.searchParams.get("path") ?? "/workspace";
    return Response.json(await runApp(listWorkspaceDirectory(target, path)));
  } catch (error) {
    return workspaceApiFailure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const authentication = requireWorkspaceRequest(request, true);
  if (authentication instanceof Response) return authentication;
  const body = (await request.json().catch(() => null)) as
    | ({ action?: unknown } & Record<string, unknown>)
    | null;
  try {
    if (body === null || body.action === undefined) {
      throw new Error("A filesystem action is required.");
    }
    const target = workspaceTargetFromBody(body);
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    await runApp(mutateWorkspaceFs(target, decodeWorkspaceFsAction(body.action)));
    return Response.json({ ok: true });
  } catch (error) {
    return workspaceApiFailure(error);
  }
}
