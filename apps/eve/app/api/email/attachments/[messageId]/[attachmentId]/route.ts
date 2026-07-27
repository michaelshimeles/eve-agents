import { emailConfigured, getAttachment } from "@/agent/lib/agentmail";
import { emailFailure } from "@/lib/email-api";
import { requireWebAuth } from "@/lib/web-auth";

// Attachment downloads for the reading pane. AgentMail hands back a short-lived
// signed URL rather than bytes, so this hop exists to keep the API key on the
// server: the browser follows a redirect it could not have minted itself.

type RouteContext = { params: Promise<{ messageId: string; attachmentId: string }> };

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  if (!(await emailConfigured())) return new Response("Email is not configured", { status: 503 });

  const { messageId, attachmentId } = await ctx.params;
  try {
    const attachment = await getAttachment(
      decodeURIComponent(messageId),
      decodeURIComponent(attachmentId),
    );
    return Response.redirect(attachment.download_url, 302);
  } catch (error) {
    return emailFailure(error);
  }
}
