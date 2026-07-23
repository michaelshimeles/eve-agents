// Runs once after the deployment reaches READY: smoke-check the agent's
// health route and, when Telegram is configured, point the bot's webhook at
// the new deployment.

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

  return Response.json({ healthy, telegramWebhook });
}
