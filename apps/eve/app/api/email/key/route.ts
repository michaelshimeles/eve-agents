import {
  apiKeyHint,
  apiKeySource,
  getInbox,
  removeStoredApiKey,
  saveApiKey,
} from "@/agent/lib/agentmail";
import { emailFailure } from "@/lib/email-api";
import { requireWebAuth } from "@/lib/web-auth";

// The AgentMail credential, managed from the app itself: see which source is
// active (GET), paste a key (POST - validated against AgentMail before it is
// stored in Neon), or remove the stored one (DELETE). A key set in the
// deployment environment always wins over the stored one, so ops can override
// the app without a database write. The key itself is never returned.

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  try {
    const source = await apiKeySource();
    return Response.json({
      source,
      hint: source === "none" ? null : await apiKeyHint(),
      canStore: (process.env.DATABASE_URL ?? "").length > 0,
    });
  } catch (error) {
    return emailFailure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  if ((process.env.DATABASE_URL ?? "").length === 0) {
    return new Response(
      "Storing a key in the app needs a database (DATABASE_URL); set AGENTMAIL_API_KEY in the environment instead",
      { status: 503 },
    );
  }
  const body = (await request.json().catch(() => null)) as { apiKey?: unknown } | null;
  if (body === null || typeof body.apiKey !== "string" || body.apiKey.trim().length === 0) {
    return new Response("Pass the API key", { status: 400 });
  }

  try {
    await saveApiKey(body.apiKey);
    // Provision (or find) the inbox right away so the UI can show the address
    // as confirmation that the key really works end to end.
    const inbox = await getInbox();
    return Response.json({
      ok: true,
      source: await apiKeySource(),
      emailAddress: inbox.email ?? inbox.inbox_id,
    });
  } catch (error) {
    return emailFailure(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  try {
    await removeStoredApiKey();
    return Response.json({ ok: true, source: await apiKeySource() });
  } catch (error) {
    return emailFailure(error);
  }
}
