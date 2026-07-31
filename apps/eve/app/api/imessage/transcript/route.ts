import { listIMessageTranscript } from "@/agent/lib/effect/imessage";
import { requireIMessageTranscriptAdmin } from "@/lib/imessage-auth";
import { respondWith } from "@/lib/imessage-api";
import { requireWebAuth } from "@/lib/web-auth";

function requestedLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get("limit");
  const parsed = raw === null ? 100 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 200)) : 100;
}

/** Latest provider-facing iMessage transcript entries for Manage -> iMessage. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request) ?? requireIMessageTranscriptAdmin(request);
  if (denied) return denied;
  return respondWith(
    listIMessageTranscript(requestedLimit(request)),
    (entries) => ({ entries }),
  );
}
