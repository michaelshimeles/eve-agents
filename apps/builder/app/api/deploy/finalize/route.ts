import { getDeploymentStatus, VercelApiError } from "@/lib/vercel-api";

// Runs once after the deployment reaches READY: smoke-check the agent's
// health route, start a real (tiny) session to prove the workflow runtime
// works end to end, and, when Telegram is configured, point the bot's
// webhook at the new deployment.
//
// The session test retries for up to ~90s: a brand-new project's first-ever
// invocation pays a one-time cost (cold function + first workflow-run
// provisioning) that can exceed a single request timeout, and the retries
// double as a warm-up so the user's first real chat turn isn't the one
// paying it.
//
// The target host is never taken from the request: the caller sends their
// Vercel token + deployment id, and we resolve the hostname through the
// Vercel API. That binds all server-side requests to a deployment the
// caller's own token can access (no SSRF surface).

export const maxDuration = 180;

const SESSION_RETRY_BUDGET_MS = 90_000;
const SESSION_RETRY_DELAY_MS = 4_000;

interface FinalizeRequest {
  token?: unknown;
  teamId?: unknown;
  deploymentId?: unknown;
  telegram?: { botToken?: unknown; webhookSecret?: unknown } | null;
}

/** Eve returns error strings; Vercel's protection layer returns objects. */
function normalizeError(error: unknown): string | null {
  if (typeof error === "string" && error.length > 0) return error;
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
    return JSON.stringify(error).slice(0, 200);
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as FinalizeRequest | null;
  if (
    body === null ||
    typeof body.token !== "string" ||
    body.token.length === 0 ||
    typeof body.deploymentId !== "string" ||
    body.deploymentId.length === 0
  ) {
    return Response.json({ error: "Missing token or deploymentId" }, { status: 400 });
  }
  const teamId = typeof body.teamId === "string" && body.teamId.length > 0 ? body.teamId : null;

  let publicUrl: string;
  try {
    const deployment = await getDeploymentStatus(body.token, teamId, body.deploymentId);
    if (deployment.readyState !== "READY" || deployment.url.length === 0) {
      return Response.json({ error: "Deployment is not ready" }, { status: 409 });
    }
    // Deployment-id URLs sit behind Vercel SSO by default (Standard
    // Protection); the production alias is the publicly reachable — and
    // shareable — address. Prefer the shortest alias (the clean one).
    const alias = [...deployment.aliases].sort((a, b) => a.length - b.length)[0];
    publicUrl = alias ?? deployment.url;
  } catch (error) {
    const message = error instanceof VercelApiError ? error.message : "Could not verify deployment";
    return Response.json({ error: message }, { status: 502 });
  }
  const base = `https://${publicUrl}`;

  let healthy = false;
  try {
    // redirect: "manual" so an SSO login redirect can't masquerade as healthy.
    const health = await fetch(`${base}/eve/v1/health`, {
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    healthy = health.ok;
  } catch {
    healthy = false;
  }

  // A real message-send exercises the workflow runtime (the part that fails
  // when Vercel serves stale identity tokens after a same-name project was
  // deleted and recreated). The turn runs invisibly; no chat thread is made.
  let sessionOk = false;
  let sessionError: string | null = null;
  const deadline = Date.now() + SESSION_RETRY_BUDGET_MS;
  for (;;) {
    try {
      const session = await fetch(`${base}/eve/v1/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Reply with the single word: ok" }),
        signal: AbortSignal.timeout(25000),
        redirect: "manual",
      });
      const payload = (await session.json().catch(() => null)) as {
        ok?: boolean;
        error?: unknown;
      } | null;
      if (session.ok && payload?.ok === true) {
        sessionOk = true;
        sessionError = null;
        break;
      }
      sessionError = normalizeError(payload?.error) ?? `HTTP ${session.status}`;
      // Deployment Protection blocks every retry the same way; bail early
      // with a message the wizard can turn into actionable guidance.
      if (session.status === 401 && /protected/i.test(sessionError)) {
        sessionError = "protected";
        break;
      }
    } catch {
      // Timeouts are the expected cold-start shape; keep warming.
      sessionError = "timeout";
    }
    if (Date.now() + SESSION_RETRY_DELAY_MS >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_DELAY_MS));
  }

  let telegramWebhook: "set" | "failed" | null = null;
  const telegram = body.telegram;
  if (
    telegram !== null &&
    telegram !== undefined &&
    typeof telegram.botToken === "string" &&
    telegram.botToken.length > 0
  ) {
    try {
      const params = new URLSearchParams({ url: `${base}/eve/v1/telegram` });
      if (typeof telegram.webhookSecret === "string" && telegram.webhookSecret.length > 0) {
        params.set("secret_token", telegram.webhookSecret);
      }
      const response = await fetch(
        `https://api.telegram.org/bot${telegram.botToken}/setWebhook?${params}`,
        { signal: AbortSignal.timeout(15000) },
      );
      const result = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      telegramWebhook = result?.ok === true ? "set" : "failed";
    } catch {
      telegramWebhook = "failed";
    }
  }

  return Response.json({ healthy, sessionOk, sessionError, telegramWebhook, publicUrl });
}
