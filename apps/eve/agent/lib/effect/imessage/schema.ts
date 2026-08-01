import { createHash } from "node:crypto";

import { Schema } from "effect";

export const IMESSAGE_OPERATIONS = [
  "send_text",
  "send_markdown",
  "send_attachment",
  "send_album",
  "send_voice",
  "send_contact",
  "send_richlink",
  "send_poll",
  "send_app",
  "update_app",
  "reply",
  "react",
  "remove_reaction",
  "edit",
  "unsend",
  "send_effect",
  "place_sticker",
  "set_background",
  "remove_background",
  "set_typing",
  "mark_read",
  "create_group",
  "rename_group",
  "set_group_icon",
  "remove_group_icon",
  "add_participant",
  "remove_participant",
  "leave_group",
  "archive_chat",
  "share_contact",
  "request_location",
  "notify_anyway",
] as const;

export type IMessageOperation = (typeof IMESSAGE_OPERATIONS)[number];

export const IMessageTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("dm"),
    handle: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("space"),
    spaceId: Schema.String,
  }),
]);
export type IMessageTarget = typeof IMessageTarget.Type;

export const IMessageActor = Schema.Struct({
  role: Schema.Literals(["owner", "guest"]),
  deploymentId: Schema.String,
});
export type IMessageActor = typeof IMessageActor.Type;

export const IMessageCommand = Schema.Struct({
  version: Schema.Literal(2),
  commandId: Schema.String,
  phone: Schema.String,
  target: IMessageTarget,
  actor: IMessageActor,
  operation: Schema.Literals(IMESSAGE_OPERATIONS),
  payload: Schema.Unknown,
});
export type IMessageCommand = typeof IMessageCommand.Type;

export type IMessageFailureCategory =
  | "validation"
  | "authorization"
  | "unsupported"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "retryable_provider"
  | "permanent_provider";

export interface IMessageCommandSuccess {
  readonly ok: true;
  readonly commandId: string;
  readonly messageRef?: string;
  readonly replayed: boolean;
  readonly result?: Readonly<Record<string, unknown>>;
}

export interface IMessageCommandFailure {
  readonly ok: false;
  readonly commandId: string;
  readonly category: IMessageFailureCategory;
  readonly message: string;
  readonly retryable: boolean;
}

export type IMessageCommandResult = IMessageCommandSuccess | IMessageCommandFailure;

export interface MediaRef {
  readonly mediaRef: string;
  readonly mimeType: string;
  readonly name?: string;
  readonly size?: number;
}

export interface ContactPayload {
  readonly name?: string;
  readonly phones?: readonly string[];
  readonly emails?: readonly string[];
  readonly vcard?: string;
}

export type GroupChange =
  | { readonly kind: "renamed"; readonly name: string | null }
  | { readonly kind: "icon_changed" }
  | { readonly kind: "icon_removed" }
  | { readonly kind: "participant_added"; readonly address: string }
  | { readonly kind: "participant_removed"; readonly address: string }
  | { readonly kind: "participant_left"; readonly address: string };

export type IMessageInboundEvent =
  | { readonly kind: "text"; readonly messageRef: string; readonly text: string }
  | { readonly kind: "attachment"; readonly messageRef: string; readonly media: readonly MediaRef[] }
  | { readonly kind: "voice"; readonly messageRef: string; readonly media: MediaRef }
  | { readonly kind: "contact"; readonly messageRef: string; readonly contact: ContactPayload }
  | { readonly kind: "richlink"; readonly messageRef: string; readonly url: string }
  | { readonly kind: "reaction_added"; readonly messageRef: string; readonly reaction: string }
  | { readonly kind: "reaction_removed"; readonly messageRef: string; readonly reaction: string }
  | { readonly kind: "poll_vote"; readonly interactionRef: string; readonly optionId: string }
  | { readonly kind: "edited"; readonly messageRef: string; readonly text: string }
  | { readonly kind: "unsent"; readonly messageRef: string }
  | { readonly kind: "read"; readonly messageRef: string }
  | { readonly kind: "group_changed"; readonly change: GroupChange }
  | { readonly kind: "sticker_placed"; readonly messageRef: string; readonly sticker: MediaRef }
  | { readonly kind: "unknown"; readonly providerType: string };

export function commandConversationKey(command: IMessageCommand): string {
  return command.target.kind === "dm"
    ? `dm:${command.phone}:${command.target.handle}`
    : `space:${command.phone}:${command.target.spaceId}`;
}

export function requiresOwner(command: IMessageCommand): boolean {
  return (
    command.operation === "create_group" ||
    command.operation === "rename_group" ||
    command.operation === "set_group_icon" ||
    command.operation === "remove_group_icon" ||
    command.operation === "add_participant" ||
    command.operation === "remove_participant" ||
    command.operation === "leave_group" ||
    command.operation === "archive_chat" ||
    command.operation === "request_location" ||
    command.operation === "notify_anyway"
  );
}

export function commandIdFor(
  eveRequestId: string,
  assistantBlockId: string,
  operationIndex: number,
): string {
  return `${eveRequestId}:${assistantBlockId}:${operationIndex}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sensitiveCommandPayloadHash(
  operation: IMessageOperation,
  payload: unknown,
): string {
  const value =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {};
  delete value.approval;
  return createHash("sha256")
    .update(`${operation}\0${canonicalJson(value)}`)
    .digest("hex");
}
