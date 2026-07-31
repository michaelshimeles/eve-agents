import { createHash } from "node:crypto";

import { settingsStore } from "./settings-db";

export const IMESSAGE_FEATURE_FLAGS = [
  "imessage_passive_rich_ingest",
  "imessage_durable_router",
  "imessage_native_markdown",
  "imessage_rich_media",
  "imessage_voice",
  "imessage_streaming_edits",
  "imessage_replies_reactions",
  "imessage_polls",
  "imessage_universal_apps",
  "imessage_branded_extension",
  "imessage_group_admin",
  "imessage_advanced_kit",
  "imessage_stickers",
  "imessage_focus_notify",
  "imessage_location",
] as const;

export type IMessageFeatureFlag = (typeof IMESSAGE_FEATURE_FLAGS)[number];

export const IMESSAGE_RICH_EXPERIENCE_FLAGS = [
  "imessage_native_markdown",
  "imessage_rich_media",
  "imessage_voice",
  "imessage_streaming_edits",
  "imessage_replies_reactions",
  "imessage_polls",
  "imessage_universal_apps",
] as const satisfies readonly IMessageFeatureFlag[];

const DEFAULTS: Readonly<Record<IMessageFeatureFlag, boolean>> = {
  imessage_passive_rich_ingest: true,
  imessage_durable_router: true,
  imessage_native_markdown: false,
  imessage_rich_media: false,
  imessage_voice: false,
  imessage_streaming_edits: false,
  imessage_replies_reactions: false,
  imessage_polls: false,
  imessage_universal_apps: false,
  imessage_branded_extension: false,
  imessage_group_admin: false,
  imessage_advanced_kit: false,
  imessage_stickers: false,
  imessage_focus_notify: false,
  imessage_location: false,
};

function booleanSetting(value: string | null): boolean | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "off") return false;
  return null;
}

function conversationSettingName(
  flag: IMessageFeatureFlag,
  conversationKey: string,
): string {
  const hash = createHash("sha256")
    .update(conversationKey)
    .digest("base64url")
    .slice(0, 20);
  return `${flag}:conversation:${hash}`;
}

export async function isIMessageFeatureEnabled(
  flag: IMessageFeatureFlag,
  conversationKey?: string,
): Promise<boolean> {
  if (process.env.IMESSAGE_GLOBAL_KILL_SWITCH?.trim().toLowerCase() === "true") {
    return false;
  }
  const envOverride = booleanSetting(process.env[flag.toUpperCase()] ?? null);
  if (envOverride !== null) return envOverride;
  if (conversationKey !== undefined) {
    const scoped = booleanSetting(
      await settingsStore.getFresh(conversationSettingName(flag, conversationKey)),
    );
    if (scoped !== null) return scoped;
  }
  const global = booleanSetting(await settingsStore.getFresh(flag));
  return global ?? DEFAULTS[flag];
}

export async function setIMessageFeatureFlag(
  flag: IMessageFeatureFlag,
  enabled: boolean,
  conversationKey?: string,
): Promise<void> {
  await settingsStore.set(
    conversationKey === undefined
      ? flag
      : conversationSettingName(flag, conversationKey),
    String(enabled),
  );
}

export async function setIMessageRichExperienceEnabled(
  enabled: boolean,
): Promise<void> {
  await Promise.all(
    IMESSAGE_RICH_EXPERIENCE_FLAGS.map((flag) =>
      setIMessageFeatureFlag(flag, enabled),
    ),
  );
}

export function defaultIMessageFeatureFlags(): Readonly<
  Record<IMessageFeatureFlag, boolean>
> {
  return DEFAULTS;
}

export type IMessageVoiceReplyMode = "mirror" | "text" | "always";

export async function iMessageVoiceReplyMode(): Promise<IMessageVoiceReplyMode> {
  const envMode = process.env.IMESSAGE_VOICE_REPLY_MODE?.trim().toLowerCase();
  if (envMode === "mirror" || envMode === "text" || envMode === "always") {
    return envMode;
  }
  const stored = (await settingsStore.getFresh("imessage_voice_reply_mode"))
    ?.trim()
    .toLowerCase();
  return stored === "text" || stored === "always" ? stored : "mirror";
}

export async function setIMessageVoiceReplyMode(
  mode: IMessageVoiceReplyMode,
): Promise<void> {
  await settingsStore.set("imessage_voice_reply_mode", mode);
}
