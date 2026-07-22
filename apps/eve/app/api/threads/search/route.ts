import { searchThreads } from "@/lib/threads-db";
import { requireWebAuth } from "@/lib/web-auth";

// Full-text search across the server-side thread store. Matches user and
// assistant message text inside each thread's persisted event log, so old
// conversations are findable by what was said, not just their titles.

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) return Response.json({ results: [] });

  const results = await searchThreads(query, 20);
  return Response.json({ results });
}
