import { createWorkspaceLoginResponse } from "@/lib/workspace-auth";

export async function POST(request: Request): Promise<Response> {
  return createWorkspaceLoginResponse(request);
}
