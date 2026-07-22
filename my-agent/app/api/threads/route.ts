import { listThreads } from "@/lib/threads-db";
import { requireWebAuth } from "@/lib/web-auth";

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  const threads = await listThreads();
  return Response.json({ threads });
}
