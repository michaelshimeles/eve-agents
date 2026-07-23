// Runs once after the deployment reaches READY: smoke-check the agent's
// health route, start a real (tiny) session to prove the workflow runtime
// works end to end, and, when Telegram is configured, point the bot's
// webhook at the new deployment.

interface FinalizeRequest {
  deploymentUrl?: unknown;
  telegram?: { botToken?: unknown; webhookSecret?: unknown } | null;
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as FinalizeRequest | null;
  if (body === null || typeof body.deploymentUrl !== "string" || body.deploymentUrl.length === 0) {
    return Response.json({ error: "Missing deploymentUrl" }, { status: 400 });
  }
  const base = `https://${body.deploymentUrl.replace(/^https?:\/\//, "")}`;

  let healthy = false;
  try {
    const health = await fetch(`${base}/eve/v1/health`, { signal: AbortSignal.timeout(15000) });
    healthy = health.ok;
  } catch {
    healthy = false;
  }

  // A real message-send exercises the workflow runtime (the part that fails
  // when Vercel serves stale identity tokens after a same-name project was
  // deleted and recreated). The turn runs invisibly; no chat thread is made.
  let sessionOk = false;
  try {
    const session = await fetch(`${base}/eve/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Reply with the single word: ok" }),
      signal: AbortSignal.timeout(20000),
    });
    const payload = (await session.json().catch(() => null)) as { ok?: boolean } | null;
    sessionOk = session.ok && payload?.ok === true;
  } catch {
    sessionOk = false;
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

  return Response.json({ healthy, sessionOk, telegramWebhook });
}
