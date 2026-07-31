import {
  listWorkspaceProcesses,
  signalWorkspaceProcess,
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
    const target = workspaceTargetFromUrl(new URL(request.url));
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    return Response.json({ processes: await runApp(listWorkspaceProcesses(target)) });
  } catch (error) {
    return workspaceApiFailure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const authentication = requireWorkspaceRequest(request, true);
  if (authentication instanceof Response) return authentication;
  const body = (await request.json().catch(() => null)) as
    | ({ pid?: number; signal?: "TERM" | "KILL" } & Record<string, unknown>)
    | null;
  try {
    if (
      body === null ||
      !Number.isSafeInteger(body.pid) ||
      (body.signal !== "TERM" && body.signal !== "KILL")
    ) {
      throw new Error("A valid PID and signal are required.");
    }
    const target = workspaceTargetFromBody(body);
    const denied = await authorizeWorkspaceTarget(authentication, target);
    if (denied) return denied;
    await runApp(signalWorkspaceProcess(target, body.pid as number, body.signal));
    return Response.json({ ok: true });
  } catch (error) {
    return workspaceApiFailure(error);
  }
}
