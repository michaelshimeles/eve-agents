import { ruthLocalDownloadUrl } from "@/lib/local-computer-api";
import { requireWebAuth } from "@/lib/web-auth";

export function GET(request: Request): Response {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  return Response.redirect(ruthLocalDownloadUrl(), 307);
}

export const dynamic = "force-dynamic";
