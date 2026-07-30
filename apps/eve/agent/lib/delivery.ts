import { verifiedPhone } from "./effect/agentphone";
import { verifiedIMessagePairing } from "./effect/imessage";
import { runTool } from "./effect/runtime";
import { db } from "./neon";
import { settingsStore } from "./settings-db";

// Where proactive results (fired reminders and event triggers) get delivered.
// By default delivery follows where the automation was created; the owner can
// pin every delivery to one place from Manage -> Reminders/Triggers. The
// preference is an app-managed setting (settings-db.ts), so it applies across
// deployments of the same database without an env change.

export const DELIVERY_TARGETS = ["origin", "web", "telegram", "imessage", "slack", "phone"] as const;
export type DeliveryTarget = (typeof DELIVERY_TARGETS)[number];

const DELIVERY_SETTING = "proactive_delivery";
const TELEGRAM_CHAT_SETTING = "telegram_owner_chat_id";
const SLACK_CHANNEL_SETTING = "slack_owner_channel_id";

export function isDeliveryTarget(value: unknown): value is DeliveryTarget {
  return typeof value === "string" && (DELIVERY_TARGETS as readonly string[]).includes(value);
}

export async function getDeliveryTarget(): Promise<DeliveryTarget> {
  // Fresh read on purpose: a fire moments after the owner changes the
  // preference must honor the new value, and automations fire far too
  // rarely for the cached (stale-while-revalidate) path to catch up.
  const value = await settingsStore.getFresh(DELIVERY_SETTING);
  return isDeliveryTarget(value) ? value : "origin";
}

export async function setDeliveryTarget(target: DeliveryTarget): Promise<void> {
  // "origin" is the unset default; storing nothing keeps fresh databases and
  // reset preferences indistinguishable.
  if (target === "origin") {
    await settingsStore.delete(DELIVERY_SETTING);
    return;
  }
  await settingsStore.set(DELIVERY_SETTING, target);
}

/**
 * Remembers the owner's private Telegram chat so web-created automations can
 * deliver there when the owner picks Telegram. Best-effort by design: losing
 * a write only means the link is learned from the next message instead.
 */
export async function rememberOwnerTelegramChat(chatId: string): Promise<void> {
  if (chatId.length === 0) return;
  try {
    const current = await settingsStore.get(TELEGRAM_CHAT_SETTING);
    if (current === chatId) return;
    await settingsStore.set(TELEGRAM_CHAT_SETTING, chatId);
  } catch (error) {
    console.error("Recording the owner's Telegram chat failed.", error);
  }
}

/**
 * The owner's Telegram DM, or null when no message has been seen and no
 * automation was ever created from Telegram. The row fallbacks cover owners
 * from before the chat id was recorded on inbound messages — this is a
 * personal agent (DMs only), so any row's chat is the owner's.
 */
export async function ownerTelegramChatId(): Promise<string | null> {
  const stored = await settingsStore.getFresh(TELEGRAM_CHAT_SETTING);
  if (stored !== null) return stored;
  if ((process.env.DATABASE_URL ?? "").trim().length === 0) return null;
  for (const table of ["reminders", "webhooks"]) {
    try {
      const rows = await db().query(
        `SELECT chat_id FROM ${table} WHERE chat_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      );
      const chatId = (rows[0] as { chat_id?: string } | undefined)?.chat_id;
      if (chatId !== undefined && chatId.length > 0) return chatId;
    } catch {
      // The table may not exist yet; a fallback miss reads as "not linked".
    }
  }
  return null;
}

/**
 * Remembers the owner's Slack DM so web-created automations can deliver there
 * when the owner picks Slack. Best-effort by design, like the Telegram one:
 * losing a write only means the link is learned from the next DM.
 */
export async function rememberOwnerSlackChannel(channelId: string): Promise<void> {
  if (channelId.length === 0) return;
  try {
    const current = await settingsStore.get(SLACK_CHANNEL_SETTING);
    if (current === channelId) return;
    await settingsStore.set(SLACK_CHANNEL_SETTING, channelId);
  } catch (error) {
    console.error("Recording the owner's Slack channel failed.", error);
  }
}

/**
 * The owner's Slack DM channel, or null until they have DMed the agent once.
 * Unlike the Telegram lookup there is no reminders/webhooks table fallback:
 * that exists only to cover owners from before the chat id was recorded, and
 * Slack has no such history.
 */
export async function ownerSlackChannelId(): Promise<string | null> {
  return settingsStore.getFresh(SLACK_CHANNEL_SETTING);
}

export type DeliveryRoute =
  | { kind: "telegram"; chatId: string }
  | { kind: "imessage"; handle: string }
  | { kind: "slack"; channelId: string }
  | { kind: "phone"; target: string }
  | {
      kind: "web";
      /** Whether to also text the paired iMessage number, when there is one. */
      mirror: boolean;
    };

/**
 * Where one proactive run should deliver. `originChatId` is the Telegram chat
 * the automation was created from, when there was one. An explicit target
 * that is unavailable right now (no Telegram chat known, iMessage unpaired)
 * falls back to the web path so a fired automation never goes nowhere.
 */
export async function resolveDeliveryRoute(originChatId: string | null): Promise<DeliveryRoute> {
  const target = await getDeliveryTarget();
  if (target === "web") return { kind: "web", mirror: false };
  if (target === "telegram") {
    const chatId = originChatId ?? (await ownerTelegramChatId());
    return chatId !== null ? { kind: "telegram", chatId } : { kind: "web", mirror: true };
  }
  if (target === "imessage") {
    const pairing = await runTool(verifiedIMessagePairing()).catch(() => null);
    return pairing !== null
      ? { kind: "imessage", handle: pairing.handle }
      : { kind: "web", mirror: true };
  }
  if (target === "slack") {
    const channelId = await ownerSlackChannelId();
    return channelId !== null ? { kind: "slack", channelId } : { kind: "web", mirror: true };
  }
  if (target === "phone") {
    // Needs both a provisioned line and a known owner: without the owner's
    // number there is nobody to text.
    const phone = await runTool(verifiedPhone()).catch(() => null);
    return phone?.ownerNumber != null
      ? { kind: "phone", target: phone.ownerNumber }
      : { kind: "web", mirror: true };
  }
  // "origin": follow where the automation was created.
  if (originChatId !== null) return { kind: "telegram", chatId: originChatId };
  return { kind: "web", mirror: true };
}

export interface DeliveryView {
  target: DeliveryTarget;
  /** A Telegram DM for the owner is known, so "telegram" would deliver. */
  telegramLinked: boolean;
  /** An iMessage number is paired, so "imessage" would deliver. */
  imessagePaired: boolean;
  /** A Slack DM for the owner is known, so "slack" would deliver. */
  slackLinked: boolean;
  /** A phone number is provisioned and the owner is known, so "phone" would deliver. */
  phoneReady: boolean;
}

/** The delivery preference plus availability, for the manage UI. */
export async function deliveryView(): Promise<DeliveryView> {
  const [target, chatId, pairing, slackChannelId, phone] = await Promise.all([
    getDeliveryTarget(),
    ownerTelegramChatId(),
    runTool(verifiedIMessagePairing()).catch(() => null),
    ownerSlackChannelId(),
    runTool(verifiedPhone()).catch(() => null),
  ]);
  return {
    target,
    telegramLinked: chatId !== null,
    imessagePaired: pairing !== null,
    slackLinked: slackChannelId !== null,
    phoneReady: phone?.ownerNumber != null,
  };
}
