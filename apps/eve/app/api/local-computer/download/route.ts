import { ruthLocalDownloadUrl } from "@/lib/local-computer-api";
import { requireWebAuth } from "@/lib/web-auth";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  return Response.redirect(ruthLocalDownloadUrl(), 307);
}

export const dynamic = "force-dynamic";
