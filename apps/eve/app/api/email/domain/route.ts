import { emailConfigured } from "@/agent/lib/agentmail";
import {
  checkEmailDomain,
  connectEmailDomain,
  removeEmailDomain,
} from "@/agent/lib/email-domain";
import { emailFailure } from "@/lib/email-api";
import { requireWebAuth } from "@/lib/web-auth";

// Custom-domain management for the email page: status + DNS records (GET,
// which also nudges verification along and completes the address switch),
// connect (POST), disconnect (DELETE). Thin wrappers over the same workflow
// the agent's connect/check/remove_email_domain tools use, so the page and
// the agent always agree on what is connected.

export async function GET(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  if (!(await emailConfigured())) return new Response("Email is not configured", { status: 503 });
  try {
    return Response.json(await checkEmailDomain());
  } catch (error) {
    return emailFailure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  if (!(await emailConfigured())) return new Response("Email is not configured", { status: 503 });

  const body = (await request.json().catch(() => null)) as { domain?: unknown } | null;
  if (body === null || typeof body.domain !== "string" || body.domain.trim().length === 0) {
    return new Response("Pass the domain to connect", { status: 400 });
  }
  try {
    return Response.json(await connectEmailDomain(body.domain));
  } catch (error) {
    return emailFailure(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  if (!(await emailConfigured())) return new Response("Email is not configured", { status: 503 });
  try {
    return Response.json(await removeEmailDomain());
  } catch (error) {
    return emailFailure(error);
  }
}
