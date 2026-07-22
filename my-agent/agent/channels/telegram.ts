import { defaultTelegramAuth, telegramChannel } from "eve/channels/telegram";

// Credentials come from TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET_TOKEN.
// The webhook route is mounted at POST /eve/v1/telegram.
//
// This is a personal agent: it only answers private DMs, and when
// TELEGRAM_ALLOWED_USER_IDS is set (comma-separated Telegram user ids),
// only messages from those users. Everyone else is silently ignored.
function allowedUserIds(): string[] {
  return (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export default telegramChannel({
  botUsername: "eve_tele_bot",
  async onMessage(ctx, message) {
    if (message.chat.type !== "private") return null;
    if (message.from?.isBot === true) return null;

    const allowlist = allowedUserIds();
    const fromId = message.from?.id;
    if (allowlist.length > 0 && (fromId === undefined || !allowlist.includes(String(fromId)))) {
      return null;
    }

    const hasContent = (message.text || message.caption).trim().length > 0 || message.attachments.length > 0;
    if (!hasContent) return null;

    await ctx.telegram.startTyping();
    return { auth: defaultTelegramAuth(message) };
  },
  uploadPolicy: {
    allowedMediaTypes: ["image/*", "application/pdf"],
    maxBytes: 10 * 1024 * 1024,
  },
});
