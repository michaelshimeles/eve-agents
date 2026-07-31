import { basename } from "node:path";

import { Effect } from "effect";
import type {
  AdvancedIMessage,
  IMessageError as PhotonAdvancedError,
  MiniAppCardSession,
  MessageEffect,
  SettableMessageReaction,
  TextEffect,
  TextFormatInput,
} from "@photon-ai/advanced-imessage/grpc";

import { IMessageError } from "../imessage";
import { synthesizeIMessageSpeech } from "./media";
import { fetchPublicMedia } from "./security";
import type { IMessageCommand } from "./schema";

const MAX_PROVIDER_MEDIA_BYTES = 100 * 1024 * 1024;
const TEXT_EFFECTS = new Set([
  "big",
  "small",
  "shake",
  "nod",
  "explode",
  "ripple",
  "bloom",
  "jitter",
] as const);
const MESSAGE_EFFECTS = new Set([
  "slam",
  "loud",
  "gentle",
  "invisible",
  "confetti",
  "fireworks",
  "balloons",
  "heart",
  "lasers",
  "celebration",
  "sparkles",
  "spotlight",
  "echo",
] as const);
const ADVANCED_OPERATIONS = new Set<IMessageCommand["operation"]>([
  "send_text",
  "send_markdown",
  "send_effect",
  "send_attachment",
  "send_voice",
  "send_album",
  "send_poll",
  "send_app",
  "update_app",
  "reply",
  "edit",
  "unsend",
  "react",
  "remove_reaction",
  "place_sticker",
  "set_typing",
  "mark_read",
  "create_group",
  "rename_group",
  "set_group_icon",
  "remove_group_icon",
  "add_participant",
  "remove_participant",
  "leave_group",
  "share_contact",
  "set_background",
  "remove_background",
  "request_location",
  "notify_anyway",
]);

type NativeText = {
  readonly text: string;
  readonly formatting: readonly TextFormatInput[];
};

export interface AdvancedCommandResult {
  readonly providerMessageId?: string;
  readonly result?: Readonly<Record<string, unknown>>;
}

export interface AdvancedHealth {
  readonly configured: boolean;
  readonly authenticated: boolean;
  readonly iMessageAvailable?: boolean;
  readonly focusSilenced?: boolean;
  readonly country?: string;
  readonly services?: readonly string[];
  readonly reason?: string;
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

export function advancedIMessageConfigured(): boolean {
  return env("PHOTON_ADVANCED_IMESSAGE_ADDRESS") !== null &&
    env("PHOTON_ADVANCED_IMESSAGE_TOKEN") !== null &&
    env("PHOTON_ADVANCED_IMESSAGE_PHONE") !== null;
}

export function advancedIMessageLine(): string | null {
  return env("PHOTON_ADVANCED_IMESSAGE_PHONE");
}

export function advancedIMessageSupportsPhone(phone: string): boolean {
  const configured = advancedIMessageLine();
  return configured !== null && configured === phone.trim();
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, key: string): string {
  const field = record(value)[key];
  return typeof field === "string" ? field : "";
}

function numberField(value: unknown, key: string): number | undefined {
  const field = record(value)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function stringArray(value: unknown, key: string): readonly string[] {
  const field = record(value)[key];
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === "string")
    : [];
}

function boolField(value: unknown, key: string): boolean {
  return record(value)[key] === true;
}

function boundedNumber(
  value: unknown,
  key: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number | undefined {
  const number = numberField(value, key) ?? fallback;
  if (number === undefined) return undefined;
  if (number < minimum || number > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function fileNameFor(url: string, requested: string): string {
  if (requested.trim().length > 0) return basename(requested.trim());
  try {
    return basename(new URL(url).pathname) || "attachment";
  } catch {
    return "attachment";
  }
}

/**
 * Converts Ruth's inline native-format notation into exact UTF-16 ranges.
 * CommonMark bold/italic/strike are accepted alongside `<u>` and the explicit
 * `[effect=name]text[/effect]` extension for Apple's animated text effects.
 */
export function parseNativeIMessageText(source: string): NativeText {
  const expression =
    /(\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|<u>([\s\S]+?)<\/u>|\[effect=(big|small|shake|nod|explode|ripple|bloom|jitter)\]([\s\S]+?)\[\/effect\]|\*([^*\n]+?)\*|_([^_\n]+?)_)/gi;
  const formatting: TextFormatInput[] = [];
  let text = "";
  let cursor = 0;
  for (const match of source.matchAll(expression)) {
    const index = match.index ?? 0;
    text += source.slice(cursor, index);
    const value =
      match[2] ?? match[3] ?? match[4] ?? match[6] ?? match[7] ?? match[8] ?? "";
    const start = text.length;
    text += value;
    const length = value.length;
    if (match[2] !== undefined) formatting.push({ type: "bold", start, length });
    else if (match[3] !== undefined) {
      formatting.push({ type: "strikethrough", start, length });
    } else if (match[4] !== undefined) {
      formatting.push({ type: "underline", start, length });
    } else if (match[5] !== undefined && TEXT_EFFECTS.has(match[5] as TextEffect)) {
      formatting.push({
        type: "effect",
        start,
        length,
        effect: match[5] as TextEffect,
      });
    } else {
      formatting.push({ type: "italic", start, length });
    }
    cursor = index + match[0].length;
  }
  text += source.slice(cursor);
  return { text, formatting };
}

async function createAdvancedClient(): Promise<AdvancedIMessage> {
  const address = env("PHOTON_ADVANCED_IMESSAGE_ADDRESS");
  const token = env("PHOTON_ADVANCED_IMESSAGE_TOKEN");
  if (address === null || token === null) {
    throw new Error("Photon Advanced iMessage Kit is not configured");
  }
  const { createGrpcClient } = await import("@photon-ai/advanced-imessage/grpc");
  return createGrpcClient({
    address,
    token,
    tls: env("PHOTON_ADVANCED_IMESSAGE_TLS") !== "false",
    timeout: 20_000,
    retry: { initialDelay: 250, maxDelay: 2_000, maxAttempts: 3 },
  });
}

export async function withAdvancedIMessageClient<A>(
  use: (client: AdvancedIMessage) => Promise<A>,
): Promise<A> {
  const client = await createAdvancedClient();
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

async function chatFor(
  client: AdvancedIMessage,
  command: IMessageCommand,
  ownerHandle: string,
): Promise<string> {
  const payload = record(command.payload);
  const providerMessageId = stringField(payload, "providerMessageId");
  if (providerMessageId.length > 0) {
    const message = await client.messages.get(providerMessageId);
    const chatGuid = message.chatGuids[0];
    if (chatGuid !== undefined) return chatGuid;
  }
  if (command.target.kind === "space") {
    return (await client.chats.get(command.target.spaceId)).guid;
  }
  return (
    await client.chats.create([ownerHandle], {
      clientMessageId: `${command.commandId}:chat`,
    })
  ).chat.guid;
}

function reactionFor(raw: string): SettableMessageReaction {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "love" ||
    normalized === "like" ||
    normalized === "dislike" ||
    normalized === "laugh" ||
    normalized === "emphasize" ||
    normalized === "question"
  ) {
    return { kind: normalized };
  }
  if (raw.trim().length === 0) throw new Error("reaction is required");
  return { kind: "emoji", emoji: raw.trim() };
}

async function uploadUrl(
  client: AdvancedIMessage,
  url: string,
  name: string,
  companionUrl?: string,
): Promise<string> {
  const [primary, companion] = await Promise.all([
    fetchPublicMedia(url, MAX_PROVIDER_MEDIA_BYTES),
    companionUrl === undefined || companionUrl.length === 0
      ? Promise.resolve(null)
      : fetchPublicMedia(companionUrl, MAX_PROVIDER_MEDIA_BYTES),
  ]);
  const uploaded = await client.attachments.upload({
    data: primary.data,
    fileName: fileNameFor(url, name),
    ...(companion === null ? {} : { companion: { data: companion.data } }),
  });
  return uploaded.attachment.guid;
}

function messageEffect(value: string): MessageEffect | undefined {
  if (!MESSAGE_EFFECTS.has(value as never)) return undefined;
  const aliases: Record<string, MessageEffect> = {
    slam: "com.apple.MobileSMS.expressivesend.impact",
    loud: "com.apple.MobileSMS.expressivesend.loud",
    gentle: "com.apple.MobileSMS.expressivesend.gentle",
    invisible: "com.apple.MobileSMS.expressivesend.invisibleink",
    confetti: "com.apple.messages.effect.CKConfettiEffect",
    fireworks: "com.apple.messages.effect.CKFireworksEffect",
    balloons: "com.apple.messages.effect.CKBalloonEffect",
    heart: "com.apple.messages.effect.CKHeartEffect",
    lasers: "com.apple.messages.effect.CKLasersEffect",
    celebration: "com.apple.messages.effect.CKHappyBirthdayEffect",
    sparkles: "com.apple.messages.effect.CKSparklesEffect",
    spotlight: "com.apple.messages.effect.CKSpotlightEffect",
    echo: "com.apple.messages.effect.CKEchoEffect",
  };
  return aliases[value];
}

async function executeAdvanced(
  client: AdvancedIMessage,
  command: IMessageCommand,
  ownerHandle: string,
): Promise<AdvancedCommandResult | null> {
  if (!ADVANCED_OPERATIONS.has(command.operation)) return null;
  const payload = record(command.payload);
  const idempotency = { clientMessageId: command.commandId };

  if (command.operation === "create_group") {
    const addresses = stringArray(payload, "addresses");
    if (addresses.length < 2) throw new Error("group creation requires at least two addresses");
    const availability = await Promise.all(
      addresses.map(async (address) => ({
        address,
        available: await client.addresses.isIMessageAvailable(address),
      })),
    );
    const unavailable = availability
      .filter((entry) => !entry.available)
      .map((entry) => entry.address);
    if (unavailable.length > 0) {
      throw new Error("every participant must be available on iMessage");
    }
    const created = await client.chats.create([...addresses], {
      ...idempotency,
      ...(stringField(payload, "text").length > 0
        ? { message: stringField(payload, "text") }
        : {}),
    });
    return {
      providerMessageId: created.initialMessage?.guid,
      result: { spaceId: created.chat.guid },
    };
  }

  const chat = await chatFor(client, command, ownerHandle);
  switch (command.operation) {
    case "send_text": {
      const text = stringField(payload, "text");
      const sent = await client.messages.sendText(chat, text, idempotency);
      return { providerMessageId: sent.guid };
    }
    case "send_markdown": {
      const native = parseNativeIMessageText(stringField(payload, "text"));
      const sent = await client.messages.sendText(chat, native.text, {
        ...idempotency,
        formatting: native.formatting,
        enableDataDetection: true,
        enableLinkPreview: true,
      });
      return { providerMessageId: sent.guid };
    }
    case "send_effect": {
      const effect = messageEffect(stringField(payload, "effect"));
      if (effect === undefined) throw new Error("unsupported message effect");
      const sent = await client.messages.sendText(chat, stringField(payload, "text"), {
        ...idempotency,
        effect,
      });
      return { providerMessageId: sent.guid };
    }
    case "send_attachment":
    case "send_voice": {
      const voiceText = stringField(payload, "text");
      const attachmentGuid =
        command.operation === "send_voice" && voiceText.trim().length > 0
          ? await (async () => {
              const speech = await Effect.runPromise(synthesizeIMessageSpeech(voiceText));
              return (
                await client.attachments.upload({
                  data: speech.bytes,
                  fileName: speech.fileName,
                })
              ).attachment.guid;
            })()
          : await uploadUrl(
              client,
              stringField(payload, "url"),
              stringField(payload, "name"),
              stringField(payload, "companionUrl"),
            );
      const sent = await client.messages.sendAttachment(chat, attachmentGuid, {
        ...idempotency,
        isAudioMessage: command.operation === "send_voice",
      });
      return { providerMessageId: sent.guid };
    }
    case "send_album": {
      const urls = stringArray(payload, "urls");
      if (urls.length < 2) throw new Error("an album requires at least two attachments");
      const uploaded = await Promise.all(
        urls.map((url) => uploadUrl(client, url, "")),
      );
      const sent = await client.messages.sendMultipart(
        chat,
        uploaded.map((attachmentGuid) => ({ attachmentGuid })),
        idempotency,
      );
      return { providerMessageId: sent.guid };
    }
    case "send_poll": {
      const poll = await client.polls.create(
        chat,
        stringField(payload, "title"),
        [...stringArray(payload, "choices")],
        idempotency,
      );
      return {
        providerMessageId: poll.pollMessageGuid,
        result: {
          optionIds: poll.options.map((option) => option.optionIdentifier),
        },
      };
    }
    case "reply": {
      const target = stringField(payload, "providerMessageId");
      const native = parseNativeIMessageText(stringField(payload, "text"));
      const sent = await client.messages.sendText(chat, native.text, {
        ...idempotency,
        formatting: native.formatting,
        replyTo: target,
      });
      return { providerMessageId: sent.guid };
    }
    case "edit": {
      const sent = await client.messages.edit(
        chat,
        stringField(payload, "providerMessageId"),
        parseNativeIMessageText(stringField(payload, "text")).text,
        idempotency,
      );
      return { providerMessageId: sent.guid };
    }
    case "unsend":
      await client.messages.unsend(
        chat,
        stringField(payload, "providerMessageId"),
        idempotency,
      );
      return {};
    case "react":
    case "remove_reaction": {
      const sent = await client.messages.setReaction(
        chat,
        stringField(payload, "providerMessageId"),
        reactionFor(stringField(payload, "reaction")),
        command.operation === "react",
        idempotency,
      );
      return { providerMessageId: sent.guid };
    }
    case "place_sticker": {
      const stickerGuid = await uploadUrl(
        client,
        stringField(payload, "url"),
        stringField(payload, "name") || "sticker.png",
      );
      const sent = await client.messages.placeSticker(
        chat,
        stringField(payload, "providerMessageId"),
        stickerGuid,
        {
          x: boundedNumber(payload, "x", 0, 1, 0.5) ?? 0.5,
          y: boundedNumber(payload, "y", 0, 1, 0.5) ?? 0.5,
          ...(numberField(payload, "scale") === undefined
            ? {}
            : { scale: boundedNumber(payload, "scale", 0.1, 3) }),
          ...(numberField(payload, "rotation") === undefined
            ? {}
            : {
                rotation: boundedNumber(
                  payload,
                  "rotation",
                  -2 * Math.PI,
                  2 * Math.PI,
                ),
              }),
          ...(numberField(payload, "width") === undefined
            ? {}
            : { width: boundedNumber(payload, "width", 1, 1_024) }),
        },
        {
          ...idempotency,
          ...(numberField(payload, "partIndex") === undefined
            ? {}
            : {
                partIndex: Math.floor(
                  boundedNumber(payload, "partIndex", 0, 1_000) ?? 0,
                ),
              }),
        },
      );
      return { providerMessageId: sent.guid };
    }
    case "set_typing":
      await client.chats.setTyping(chat, stringField(payload, "state") === "start");
      return {};
    case "mark_read":
      await client.chats.markRead(chat);
      return {};
    case "rename_group":
      if (!(await client.chats.get(chat)).isGroup) {
        throw new Error("group administration requires an authoritative group chat");
      }
      await client.groups.setDisplayName(chat, stringField(payload, "name"), idempotency);
      return {};
    case "set_group_icon": {
      if (!(await client.chats.get(chat)).isGroup) {
        throw new Error("group administration requires an authoritative group chat");
      }
      const icon = await fetchPublicMedia(
        stringField(payload, "url"),
        MAX_PROVIDER_MEDIA_BYTES,
      );
      await client.groups.setIcon(chat, icon.data, idempotency);
      return {};
    }
    case "remove_group_icon":
      if (!(await client.chats.get(chat)).isGroup) {
        throw new Error("group administration requires an authoritative group chat");
      }
      await client.groups.removeIcon(chat, idempotency);
      return {};
    case "add_participant": {
      const current = await client.chats.get(chat);
      if (!current.isGroup) {
        throw new Error("group administration requires an authoritative group chat");
      }
      const additions = stringArray(payload, "addresses");
      const availability = await Promise.all(
        additions.map((address) => client.addresses.isIMessageAvailable(address)),
      );
      if (availability.some((available) => !available)) {
        throw new Error("every added participant must be available on iMessage");
      }
      await client.groups.addParticipants(
        chat,
        [...additions],
        idempotency,
      );
      return {};
    }
    case "remove_participant": {
      const current = await client.chats.get(chat);
      if (!current.isGroup) {
        throw new Error("group administration requires an authoritative group chat");
      }
      const members = new Set(
        current.participants.map((participant) => participant.address),
      );
      const removals = stringArray(payload, "addresses");
      if (removals.some((address) => !members.has(address))) {
        throw new Error("the participant list changed; refresh before removing anyone");
      }
      await client.groups.removeParticipants(
        chat,
        [...removals],
        idempotency,
      );
      return {};
    }
    case "leave_group":
      if (!(await client.chats.get(chat)).isGroup) {
        throw new Error("group administration requires an authoritative group chat");
      }
      await client.groups.leave(chat, idempotency);
      return {};
    case "share_contact":
      await client.chats.shareContactInfo(chat);
      return {};
    case "set_background": {
      const image = await fetchPublicMedia(
        stringField(payload, "url"),
        MAX_PROVIDER_MEDIA_BYTES,
      );
      await client.chats.setBackground(chat, image.data);
      return {};
    }
    case "remove_background":
      await client.chats.removeBackground(chat);
      return {};
    case "request_location": {
      const address = stringField(payload, "address") || ownerHandle;
      const receipt = await client.locations.request(chat, address, idempotency);
      return {
        providerMessageId: receipt.messageGuid,
        result: {
          requested: receipt.status,
          ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
        },
      };
    }
    case "notify_anyway":
      if (!(await client.addresses.isFocusSilenced(ownerHandle))) {
        throw new Error("the owner is not currently reported as Focus-silenced");
      }
      await client.messages.notifySilenced(
        chat,
        stringField(payload, "providerMessageId"),
        idempotency,
      );
      return {};
    case "send_app": {
      const extensionBundleId = env("PHOTON_IMESSAGE_EXTENSION_BUNDLE_ID");
      const teamId = env("PHOTON_IMESSAGE_APPLE_TEAM_ID");
      if (extensionBundleId === null || teamId === null) return null;
      const sent = await client.messages.sendCustomizedMiniApp(
        chat,
        {
          appName: env("PHOTON_IMESSAGE_APP_NAME") ?? "Ruth",
          extensionBundleId,
          teamId,
          url: stringField(payload, "url"),
          live: boolField(payload, "live"),
          layout: {
            caption: stringField(payload, "caption") || "Open with Ruth",
            summary: stringField(payload, "summary") || "Interactive Ruth experience",
          },
          ...(Number(env("PHOTON_IMESSAGE_APP_STORE_ID")) > 0
            ? { appStoreId: Number(env("PHOTON_IMESSAGE_APP_STORE_ID")) }
            : {}),
        },
        idempotency,
      );
      return {
        providerMessageId: sent.guid,
        result: { miniAppCardSession: sent.miniAppCardSession },
      };
    }
    case "update_app": {
      const providerState = record(payload.providerState);
      const rawSession = record(providerState.miniAppCardSession);
      const session = {
        chatGuid: stringField(rawSession, "chatGuid"),
        messageGuid: stringField(rawSession, "messageGuid"),
        sessionId: stringField(rawSession, "sessionId"),
        targetMessageGuid: stringField(rawSession, "targetMessageGuid"),
      } satisfies MiniAppCardSession;
      if (Object.values(session).some((value) => value.length === 0)) {
        throw new Error("the Mini App card session is unavailable");
      }
      const extensionBundleId = env("PHOTON_IMESSAGE_EXTENSION_BUNDLE_ID");
      const teamId = env("PHOTON_IMESSAGE_APPLE_TEAM_ID");
      if (extensionBundleId === null || teamId === null) return null;
      const updated = await client.messages.updateCustomizedMiniApp(
        session,
        {
          appName: env("PHOTON_IMESSAGE_APP_NAME") ?? "Ruth",
          extensionBundleId,
          teamId,
          url: stringField(payload, "url"),
          live: boolField(payload, "live"),
          layout: {
            caption: stringField(payload, "caption") || "Open with Ruth",
            summary:
              stringField(payload, "summary") ||
              "Interactive Ruth experience",
          },
          ...(Number(env("PHOTON_IMESSAGE_APP_STORE_ID")) > 0
            ? { appStoreId: Number(env("PHOTON_IMESSAGE_APP_STORE_ID")) }
            : {}),
        },
        idempotency,
      );
      return {
        providerMessageId: updated.guid,
        result: { miniAppCardSession: updated.miniAppCardSession },
      };
    }
    default:
      return null;
  }
}

function advancedFailure(cause: unknown): IMessageError {
  const error = cause as Partial<PhotonAdvancedError>;
  return new IMessageError({
    reason: "spectrum",
    detail:
      cause instanceof Error
        ? cause.message
        : typeof error.code === "string"
          ? error.code
          : String(cause),
    retryable: error.retryable === true,
  });
}

export function executeAdvancedIMessageCommand(
  command: IMessageCommand,
  ownerHandle: string,
): Effect.Effect<AdvancedCommandResult | null, IMessageError> {
  if (
    !advancedIMessageConfigured() ||
    !advancedIMessageSupportsPhone(command.phone)
  ) {
    return Effect.succeed(null);
  }
  return Effect.tryPromise({
    try: () =>
      withAdvancedIMessageClient((client) => executeAdvanced(client, command, ownerHandle)),
    catch: advancedFailure,
  });
}

export function downloadAdvancedIMessageAttachment(
  providerAttachmentId: string,
): Effect.Effect<
  { readonly bytes: Buffer; readonly mimeType: string; readonly name: string },
  IMessageError
> {
  return Effect.tryPromise({
    try: () =>
      withAdvancedIMessageClient(async (client) => {
        const stream = client.attachments.downloadStream(providerAttachmentId);
        const chunks: Uint8Array[] = [];
        let size = 0;
        let mimeType = "application/octet-stream";
        let name = "attachment";
        try {
          for await (const item of stream) {
            if (item.type === "header") {
              mimeType = item.info.mimeType;
              name = item.info.fileName;
            } else if (item.type === "primaryChunk") {
              size += item.data.byteLength;
              if (size > MAX_PROVIDER_MEDIA_BYTES) {
                throw new Error("advanced attachment exceeds the 100 MiB provider limit");
              }
              chunks.push(item.data);
            }
          }
        } finally {
          await stream.close();
        }
        return {
          bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size),
          mimeType,
          name,
        };
      }),
    catch: advancedFailure,
  });
}

export function probeAdvancedIMessage(
  handle: string,
): Effect.Effect<AdvancedHealth, never> {
  if (!advancedIMessageConfigured()) {
    return Effect.succeed({
      configured: false,
      authenticated: false,
      reason: "Photon Advanced iMessage Kit credentials are not configured",
    });
  }
  return Effect.tryPromise({
    try: async () =>
      withAdvancedIMessageClient(async (client) => {
        const [info, iMessageAvailable, focusSilenced] = await Promise.all([
          client.addresses.get(handle),
          client.addresses.isIMessageAvailable(handle),
          client.addresses.isFocusSilenced(handle),
        ]);
        return {
          configured: true,
          authenticated: true,
          iMessageAvailable,
          focusSilenced,
          ...(info.country === null ? {} : { country: info.country }),
          services: info.services,
        } satisfies AdvancedHealth;
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause: unknown) =>
      Effect.succeed({
        configured: true,
        authenticated: false,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  );
}
