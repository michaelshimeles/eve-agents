import {
  changeWorkspaceLifecycle,
  decodeWorkspaceConfigPatch,
  decodeWorkspaceForkAction,
  decodeWorkspaceLifecycleAction,
  decodeWorkspaceSnapshotAction,
  manageWorkspaceForks,
  manageWorkspaceSnapshots,
  updateWorkspaceConfig,
  workspaceOverview,
} from "@/agent/lib/effect/sandbox-workspace";
import { runApp } from "@/agent/lib/effect/runtime";
import { devWorkspaceRelayUrl } from "@/lib/dev-workspace-relay";
import {
  authorizeWorkspaceTarget,
  requireWorkspaceRequest,
  workspaceApiFailure,
  workspaceTargetFromBody,
  workspaceTargetFromUrl,
} from "@/lib/workspace-server";

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const authentication = await requireWorkspaceRequest(request);
  if (authentication instanceof Response) return authentication;
  try {
    const target = workspaceTargetFromUrl(new URL(request.url));
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    const relayUrl = await devWorkspaceRelayUrl();
    return Response.json(await runApp(workspaceOverview(target, relayUrl)));
  } catch (error) {
    return workspaceApiFailure(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const authentication = await requireWorkspaceRequest(request, true);
  if (authentication instanceof Response) return authentication;
  const body = (await request.json().catch(() => null)) as
    | ({ patch?: unknown } & Record<string, unknown>)
    | null;
  try {
    if (body === null || body.patch === undefined) {
      throw new Error("A workspace configuration patch is required.");
    }
    const target = workspaceTargetFromBody(body);
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    await runApp(updateWorkspaceConfig(target, decodeWorkspaceConfigPatch(body.patch)));
    return Response.json({ ok: true });
  } catch (error) {
    return workspaceApiFailure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const authentication = await requireWorkspaceRequest(request, true);
  if (authentication instanceof Response) return authentication;
  const body = (await request.json().catch(() => null)) as
    | ({
        scope?: "lifecycle" | "snapshot" | "fork";
        action?: unknown;
      } & Record<string, unknown>)
    | null;
  try {
    if (body === null || body.scope === undefined || body.action === undefined) {
      throw new Error("A workspace action is required.");
    }
    const target = workspaceTargetFromBody(body);
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    if (body.scope === "lifecycle") {
      await runApp(
        changeWorkspaceLifecycle(target, decodeWorkspaceLifecycleAction(body.action)),
      );
    } else if (body.scope === "snapshot") {
      await runApp(
        manageWorkspaceSnapshots(target, decodeWorkspaceSnapshotAction(body.action)),
      );
    } else if (body.scope === "fork") {
      await runApp(manageWorkspaceForks(target, decodeWorkspaceForkAction(body.action)));
    } else {
      throw new Error("The workspace action scope is invalid.");
    }
    return Response.json({ ok: true });
  } catch (error) {
    return workspaceApiFailure(error);
  }
}
