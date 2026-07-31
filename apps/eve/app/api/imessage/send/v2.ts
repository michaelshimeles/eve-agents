import { randomUUID } from "node:crypto";

import { Schema } from "effect";

import {
  IMessageError,
  resolveIMessageDeploymentActor,
  lookupIMessageSpace,
  sendIMessageAsDeployment,
  sendIMessageAttachmentAsDeployment,
  sendIMessageEffectAsDeployment,
  sendIMessageReactionAsDeployment,
  sendIMessageRichlinkAsDeployment,
  sendIMessageTypingAsDeployment,
  setIMessageBackgroundAsDeployment,
} from "@/agent/lib/effect/imessage";
import {
  advancedIMessageConfigured,
  advancedIMessageSupportsPhone,
  executeAdvancedIMessageCommand,
} from "@/agent/lib/effect/imessage/advanced";
import { executeRichPhotonCommand } from "@/agent/lib/effect/imessage/photon";
import {
  iMessageLineAcceptsNewConversation,
  recordIMessageLineSend,
} from "@/agent/lib/effect/imessage/operations";
import { registerIMessagePollBinding } from "@/agent/lib/effect/imessage/polls";
import {
  beginIMessageLocationWatch,
  markIMessageLocationWorkflowStarted,
} from "@/agent/lib/effect/imessage/location";
import {
  IMessageCommand,
  type IMessageCommandFailure,
  type IMessageCommandResult,
  type IMessageCommandSuccess,
  commandConversationKey,
  requiresOwner,
  sensitiveCommandPayloadHash,
} from "@/agent/lib/effect/imessage/schema";
import {
  auditIMessageSecurity,
  claimIMessageCommand,
  completeIMessageCommand,
  createIMessageInteraction,
  readIMessageInteractionForAuthorization,
  registerIMessageRef,
  releaseIMessageCommand,
  resolveIMessageRef,
  resolveIMessageRefState,
} from "@/agent/lib/effect/imessage/store";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  type IMessageFeatureFlag,
  isIMessageFeatureEnabled,
} from "@/agent/lib/imessage-feature-flags";
import { imessageLocationWorkflow } from "@/app/workflows/imessage-location";
import { start } from "workflow/api";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, key: string): string {
  const field = record(value)[key];
  return typeof field === "string" ? field : "";
}

function commandPhoneAllowed(phone: string): boolean {
  const configured = process.env.SPECTRUM_LINE_PHONE?.trim() ?? "";
  return configured.length > 0 ? phone === configured : phone === "shared";
}

function failure(
  commandId: string,
  category: IMessageCommandFailure["category"],
  message: string,
  retryable = false,
): IMessageCommandFailure {
  return { ok: false, commandId, category, message, retryable };
}

function replay(result: IMessageCommandResult): IMessageCommandResult {
  return result.ok ? { ...result, replayed: true } : result;
}

function featureForOperation(
  operation: IMessageCommand["operation"],
): IMessageFeatureFlag | null {
  switch (operation) {
    case "send_markdown":
      return "imessage_native_markdown";
    case "send_attachment":
    case "send_album":
    case "send_contact":
    case "send_richlink":
      return "imessage_rich_media";
    case "send_voice":
      return "imessage_voice";
    case "reply":
    case "react":
    case "remove_reaction":
    case "edit":
    case "unsend":
      return "imessage_replies_reactions";
    case "send_poll":
      return "imessage_polls";
    case "send_app":
    case "update_app":
      return "imessage_universal_apps";
    case "create_group":
    case "rename_group":
    case "set_group_icon":
    case "remove_group_icon":
    case "add_participant":
    case "remove_participant":
    case "leave_group":
    case "archive_chat":
      return "imessage_group_admin";
    case "place_sticker":
      return "imessage_stickers";
    case "request_location":
      return "imessage_location";
    case "notify_anyway":
      return "imessage_focus_notify";
    default:
      return null;
  }
}

const RICH_OPERATIONS = new Set<IMessageCommand["operation"]>([
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
  "edit",
  "unsend",
  "create_group",
  "rename_group",
  "set_group_icon",
  "remove_group_icon",
  "add_participant",
  "remove_participant",
  "leave_group",
  "share_contact",
]);

const EXPLICIT_APPROVAL_OPERATIONS = new Set<IMessageCommand["operation"]>([
  "rename_group",
  "set_group_icon",
  "remove_group_icon",
  "remove_participant",
  "leave_group",
  "request_location",
  "notify_anyway",
]);

async function sensitiveApprovalHolds(command: IMessageCommand): Promise<boolean> {
  if (!EXPLICIT_APPROVAL_OPERATIONS.has(command.operation)) return true;
  const payload = record(command.payload);
  const approval =
    payload.approval !== null &&
    typeof payload.approval === "object" &&
    !Array.isArray(payload.approval)
      ? (payload.approval as Record<string, unknown>)
      : {};
  const interactionId =
    typeof approval.interactionId === "string" ? approval.interactionId : "";
  if (interactionId.length === 0) return false;
  const interaction = await runApp(
    readIMessageInteractionForAuthorization(interactionId),
  );
  if (
    interaction === null ||
    interaction.status !== "completed" ||
    !interaction.sensitive ||
    interaction.conversationKey !== commandConversationKey(command)
  ) {
    return false;
  }
  const state = record(interaction.state);
  const result = record(interaction.result);
  return (
    state.commandId === command.commandId &&
    state.operation === command.operation &&
    state.payloadHash ===
      sensitiveCommandPayloadHash(command.operation, command.payload) &&
    result.optionId === "approve"
  );
}

async function ensureLocationWorkflow(
  command: IMessageCommand,
  ownerHandle: string,
  ownerDeployment: string,
): Promise<void> {
  if (command.operation !== "request_location") return;
  const payload = record(command.payload);
  const durationSeconds = Math.min(
    15 * 60,
    Math.max(30, Number(payload.durationSeconds ?? 15 * 60)),
  );
  const address = stringValue(payload, "address") || ownerHandle;
  const watch = await runApp(
    beginIMessageLocationWatch({
      commandId: command.commandId,
      ownerDeployment,
      conversationKey: commandConversationKey(command),
      address,
      durationSeconds,
    }),
  );
  if (watch.workflowStarted) return;
  await start(
    imessageLocationWorkflow,
    [watch.watchId, address, watch.expiresAt, randomUUID()],
    { deploymentId: "latest" },
  );
  await runApp(markIMessageLocationWorkflowStarted(watch.watchId));
}

async function registerPollBindingBeforeCompletion(input: {
  readonly command: IMessageCommand;
  readonly executedCommand: IMessageCommand;
  readonly result: IMessageCommandSuccess;
  readonly ownerHandle: string;
}): Promise<void> {
  if (
    input.command.operation !== "send_poll" ||
    input.result.messageRef === undefined
  ) {
    return;
  }
  const payload = record(input.executedCommand.payload);
  const interactionId = stringValue(payload, "interactionId");
  const expiresAt = stringValue(payload, "expiresAt");
  const optionIds = Array.isArray(input.result.result?.optionIds)
    ? input.result.result.optionIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const choices = Array.isArray(payload.choices)
    ? payload.choices.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const interactionState = record(payload.state);
  const ruthOptions = Array.isArray(interactionState.options)
    ? interactionState.options.filter(
        (value): value is { id: string } =>
          value !== null &&
          typeof value === "object" &&
          typeof (value as { id?: unknown }).id === "string",
      )
    : [];
  if (
    interactionId.length === 0 ||
    expiresAt.length === 0 ||
    optionIds.length !== choices.length
  ) {
    throw new Error("Photon poll response did not contain a complete option mapping");
  }
  const providerMessageId = await runApp(
    resolveIMessageRef({
      messageRef: input.result.messageRef,
      phone: input.command.phone,
      conversationKey: commandConversationKey(input.command),
    }),
  );
  await runApp(
    registerIMessagePollBinding({
      providerMessageId,
      interactionId,
      conversationKey: commandConversationKey(input.command),
      ownerHandle: input.ownerHandle,
      options: optionIds.map((providerOptionId, index) => ({
        providerOptionId,
        ruthOptionId: ruthOptions[index]?.id ?? `option-${index + 1}`,
      })),
      expiresAt,
    }),
  );
}

function interactionOrigin(): string {
  const explicit = process.env.IMESSAGE_INTERACTION_PUBLIC_URL?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    const url = new URL(explicit);
    if (
      url.protocol !== "https:" &&
      process.env.IMESSAGE_ALLOW_INSECURE_LOCAL_URLS !== "true"
    ) {
      throw new Error("IMESSAGE_INTERACTION_PUBLIC_URL must use HTTPS");
    }
    return url.origin;
  }
  const deployment = process.env.VERCEL_URL?.trim();
  if (deployment !== undefined && deployment.length > 0) {
    return `https://${deployment}`;
  }
  if (process.env.IMESSAGE_ALLOW_INSECURE_LOCAL_URLS === "true") {
    return "http://127.0.0.1:3000";
  }
  throw new Error("the target-specific interaction public URL is not configured");
}

async function prepareInteractionCommand(
  command: IMessageCommand,
): Promise<IMessageCommand> {
  if (command.operation !== "send_app" && command.operation !== "send_poll") {
    return command;
  }
  const payload = record(command.payload);
  if (command.operation === "send_app" && stringValue(payload, "url").length > 0) {
    const requested = new URL(stringValue(payload, "url"));
    const origin = interactionOrigin();
    if (
      requested.origin !== origin ||
      !requested.pathname.startsWith("/imessage/apps/")
    ) {
      throw new Error("Mini App URLs must use Ruth's conversation-bound interaction origin");
    }
    return command;
  }
  const interactionState = {
    ...record(payload.state),
    deploymentUrl: command.actor.deploymentId,
  };
  const sensitive = payload.sensitive === true;
  const interaction = await runApp(
    createIMessageInteraction({
      commandId: command.commandId,
      conversationKey: commandConversationKey(command),
      eveRequestId:
        stringValue(payload, "eveRequestId") || command.commandId,
      kind: stringValue(payload, "kind") || "dynamic_card",
      sensitive,
      state: interactionState,
    }),
  );
  if (command.operation === "send_poll") {
    return {
      ...command,
      payload: {
        ...payload,
        interactionId: interaction.interactionId,
        stateVersion: interaction.stateVersion,
        expiresAt: interaction.expiresAt,
      },
    };
  }
  const url = new URL(
    `/imessage/apps/${encodeURIComponent(interaction.interactionId)}`,
    interactionOrigin(),
  );
  // Fragments reach the browser/extension but never the HTTP request line,
  // keeping the capability out of infrastructure access logs.
  url.hash = new URLSearchParams({ token: interaction.token }).toString();
  return {
    ...command,
    payload: {
      ...payload,
      url: url.toString(),
      interactionId: interaction.interactionId,
      stateVersion: interaction.stateVersion,
      expiresAt: interaction.expiresAt,
    },
  };
}

async function withResolvedProviderReference(
  command: IMessageCommand,
): Promise<IMessageCommand> {
  if (
    command.operation !== "update_app" &&
    command.operation !== "reply" &&
    command.operation !== "react" &&
    command.operation !== "remove_reaction" &&
    command.operation !== "place_sticker" &&
    command.operation !== "edit" &&
    command.operation !== "unsend" &&
    command.operation !== "notify_anyway"
  ) {
    return command;
  }
  const payload = record(command.payload);
  const messageRef = stringValue(payload, "messageRef");
  const providerMessageId = await runApp(
    resolveIMessageRef({
      messageRef,
      phone: command.phone,
      conversationKey: commandConversationKey(command),
    }),
  );
  const providerState =
    command.operation === "update_app"
      ? await runApp(
          resolveIMessageRefState({
            messageRef,
            phone: command.phone,
            conversationKey: commandConversationKey(command),
          }),
        )
      : null;
  return {
    ...command,
    payload: {
      ...payload,
      providerMessageId,
      ...(providerState === null ? {} : { providerState }),
      ...(command.operation === "update_app" &&
      stringValue(payload, "url").length === 0 &&
      stringValue(providerState, "url").length > 0
        ? { url: stringValue(providerState, "url") }
        : {}),
    },
  };
}

async function executeSupported(
  command: IMessageCommand,
  secret: string,
  ownerHandle: string,
): Promise<IMessageCommandResult> {
  const pinned = command.phone.length > 0 ? { phone: command.phone } : {};
  const target =
    command.target.kind === "space"
      ? { space: command.target.spaceId }
      : {};
  const payload = record(command.payload);
  const success = (result?: Record<string, unknown>): IMessageCommandSuccess => ({
    ok: true,
    commandId: command.commandId,
    replayed: false,
    ...(result === undefined ? {} : { result }),
  });

  switch (command.operation) {
    case "send_text":
    case "send_markdown": {
      const text = stringValue(payload, "text");
      if (text.trim().length === 0) {
        return failure(command.commandId, "validation", "text is required");
      }
      await runApp(
        sendIMessageAsDeployment({
          handle: ownerHandle,
          secret,
          text,
          ...pinned,
          ...target,
        }),
      );
      return success();
    }

    case "send_attachment": {
      if (command.target.kind !== "dm") {
        return failure(
          command.commandId,
          "unsupported",
          "group attachments require the rich-media adapter",
        );
      }
      const url = stringValue(payload, "url");
      if (url.length === 0) {
        return failure(command.commandId, "validation", "attachment URL is required");
      }
      const name = stringValue(payload, "name");
      const contentType = stringValue(payload, "contentType");
      await runApp(
        sendIMessageAttachmentAsDeployment({
          handle: ownerHandle,
          secret,
          file: {
            url,
            ...(name.length > 0 ? { name } : {}),
            ...(contentType.length > 0 ? { contentType } : {}),
          },
          ...pinned,
        }),
      );
      return success();
    }

    case "send_richlink": {
      if (command.target.kind !== "dm") {
        return failure(command.commandId, "unsupported", "group rich links are not enabled");
      }
      const url = stringValue(payload, "url");
      await runApp(
        sendIMessageRichlinkAsDeployment({
          handle: ownerHandle,
          secret,
          url,
          ...pinned,
        }),
      );
      return success();
    }

    case "send_effect": {
      if (command.target.kind !== "dm") {
        return failure(command.commandId, "unsupported", "group effects are not enabled");
      }
      await runApp(
        sendIMessageEffectAsDeployment({
          handle: ownerHandle,
          secret,
          text: stringValue(payload, "text"),
          effect: stringValue(payload, "effect"),
          ...pinned,
        }),
      );
      return success();
    }

    case "react": {
      if (command.target.kind !== "dm") {
        return failure(command.commandId, "unsupported", "group reactions are not enabled");
      }
      const messageRef = stringValue(payload, "messageRef");
      const providerMessageId = await runApp(
        resolveIMessageRef({
          messageRef,
          phone: command.phone,
          conversationKey: commandConversationKey(command),
        }),
      );
      await runApp(
        sendIMessageReactionAsDeployment({
          handle: ownerHandle,
          secret,
          reaction: {
            emoji: stringValue(payload, "reaction"),
            targetMessageId: providerMessageId,
          },
          ...pinned,
        }),
      );
      return success();
    }

    case "set_background":
    case "remove_background": {
      if (command.target.kind !== "dm") {
        return failure(command.commandId, "unsupported", "group backgrounds are not enabled");
      }
      await runApp(
        setIMessageBackgroundAsDeployment({
          handle: ownerHandle,
          secret,
          background:
            command.operation === "remove_background"
              ? "clear"
              : stringValue(payload, "url"),
          ...pinned,
        }),
      );
      return success();
    }

    case "set_typing": {
      if (command.target.kind !== "dm") {
        return failure(command.commandId, "unsupported", "group typing is not enabled");
      }
      const state = stringValue(payload, "state");
      if (state !== "start" && state !== "stop") {
        return failure(command.commandId, "validation", "typing state must be start or stop");
      }
      await runApp(
        sendIMessageTypingAsDeployment({
          handle: ownerHandle,
          secret,
          state,
          ...pinned,
        }),
      );
      return success();
    }

    default:
      return failure(
        command.commandId,
        "unsupported",
        `${command.operation} is feature-gated or requires Photon Advanced Kit entitlement`,
      );
  }
}

export async function handleV2Command(
  raw: unknown,
  secret: string,
): Promise<{ readonly status: number; readonly result: IMessageCommandResult }> {
  let command: IMessageCommand;
  try {
    command = Schema.decodeUnknownSync(IMessageCommand)(raw);
  } catch {
    return {
      status: 400,
      result: failure("", "validation", "invalid iMessage v2 command"),
    };
  }

  const actor = await runApp(resolveIMessageDeploymentActor(secret));
  if (actor === null) {
    return {
      status: 401,
      result: failure(command.commandId, "authorization", "pairing secret is not current"),
    };
  }
  if (command.actor.role !== "owner") {
    return {
      status: 403,
      result: failure(command.commandId, "authorization", "guest commands are not accepted"),
    };
  }
  if (!commandPhoneAllowed(command.phone)) {
    return {
      status: 403,
      result: failure(
        command.commandId,
        "authorization",
        "command phone is not the line assigned to this router",
      ),
    };
  }
  if (
    command.actor.deploymentId !== actor.deploymentUrl &&
    command.actor.deploymentId !== process.env.VERCEL_DEPLOYMENT_ID
  ) {
    return {
      status: 403,
      result: failure(
        command.commandId,
        "authorization",
        "command deployment identity does not match the current pairing",
      ),
    };
  }
  if (command.target.kind === "dm" && command.target.handle !== actor.handle) {
    return {
      status: 403,
      result: failure(
        command.commandId,
        "authorization",
        "direct-message target is not the paired owner",
      ),
    };
  }
  if (command.target.kind === "space") {
    const bound = await runApp(lookupIMessageSpace(command.target.spaceId));
    if (bound === null || bound.handle !== actor.handle) {
      return {
        status: 403,
        result: failure(
          command.commandId,
          "authorization",
          "group target is not bound to the paired owner",
        ),
      };
    }
  }
  if (requiresOwner(command) && command.actor.role !== "owner") {
    return {
      status: 403,
      result: failure(command.commandId, "authorization", "owner authorization is required"),
    };
  }
  const sensitiveApproved = await sensitiveApprovalHolds(command);
  if (!sensitiveApproved) {
    await runApp(
      auditIMessageSecurity({
        actionCategory: command.operation,
        actorRole: command.actor.role,
        targetType: command.target.kind,
        decision: "denied",
      }),
    );
    return {
      status: 403,
      result: failure(
        command.commandId,
        "authorization",
        "a current authenticated owner approval is required",
      ),
    };
  }
  if (EXPLICIT_APPROVAL_OPERATIONS.has(command.operation)) {
    await runApp(
      auditIMessageSecurity({
        actionCategory: command.operation,
        actorRole: command.actor.role,
        targetType: command.target.kind,
        decision: "allowed",
      }),
    );
  }
  if (
    command.operation === "create_group" &&
    !(await runApp(iMessageLineAcceptsNewConversation(command.phone)))
  ) {
    return {
      status: 429,
      result: failure(
        command.commandId,
        "rate_limited",
        "this Photon line is preserving capacity and cannot start a new conversation yet",
      ),
    };
  }

  const claim = await runApp(claimIMessageCommand(command));
  if (claim.status === "completed") {
    await ensureLocationWorkflow(command, actor.handle, actor.deploymentUrl);
    return { status: 200, result: replay(claim.result) };
  }
  if (claim.status === "pending") {
    return {
      status: 409,
      result: failure(
        command.commandId,
        "conflict",
        "the command is already in progress",
        true,
      ),
    };
  }

  let result: IMessageCommandResult;
  let providerIdempotent = false;
  let executedCommand = command;
  try {
    const feature = featureForOperation(command.operation);
    if (
      feature !== null &&
      !(await isIMessageFeatureEnabled(feature, commandConversationKey(command)))
    ) {
      result = failure(
        command.commandId,
        "unsupported",
        `${feature} is disabled for this conversation`,
      );
    } else {
      const advancedEnabled = await isIMessageFeatureEnabled(
        "imessage_advanced_kit",
        commandConversationKey(command),
      ).then(
        (enabled) =>
          enabled &&
          advancedIMessageConfigured() &&
          advancedIMessageSupportsPhone(command.phone),
      );
      if (command.operation === "send_poll" && !advancedEnabled) {
        result = failure(
          command.commandId,
          "unsupported",
          "native poll resumption requires Photon Advanced Kit event entitlement",
        );
      } else {
        const prepared = await withResolvedProviderReference(
          await prepareInteractionCommand(command),
        );
        executedCommand = prepared;
        const advanced = advancedEnabled
        ? await (async () => {
            providerIdempotent = prepared.operation !== "share_contact";
            const value = await runApp(
              executeAdvancedIMessageCommand(prepared, actor.handle),
            );
            if (value === null) providerIdempotent = false;
            return value;
          })()
        : null;
        const sent =
          advanced ??
          (RICH_OPERATIONS.has(command.operation)
            ? await runApp(executeRichPhotonCommand(prepared, actor.handle))
            : null);
        if (sent !== null) {
          const interactionId = stringValue(
            executedCommand.payload,
            "interactionId",
          );
          const commandResult =
            sent.result === undefined && interactionId.length === 0
              ? undefined
              : {
                  ...(sent.result ?? {}),
                  ...(interactionId.length === 0 ? {} : { interactionId }),
                };
          const messageRef =
            sent.providerMessageId === undefined
              ? undefined
              : await runApp(
                  registerIMessageRef({
                    providerMessageId: sent.providerMessageId,
                    phone: command.phone,
                    conversationKey: commandConversationKey(command),
                  direction: "outbound",
                  contentType: command.operation,
                  ...(sent.result?.miniAppCardSession === undefined
                    ? {}
                    : {
                        providerState: {
                          miniAppCardSession:
                            sent.result.miniAppCardSession,
                          url: stringValue(executedCommand.payload, "url"),
                        },
                      }),
                }),
                );
          result = {
            ok: true,
            commandId: command.commandId,
            replayed: false,
            ...(messageRef === undefined ? {} : { messageRef }),
            ...(commandResult === undefined ? {} : { result: commandResult }),
          };
        } else if (RICH_OPERATIONS.has(command.operation)) {
          result = failure(
            command.commandId,
            "unsupported",
            `${command.operation} is unavailable in the configured Photon adapters`,
          );
        } else {
          result = await executeSupported(command, secret, actor.handle);
        }
      }
    }
  } catch (error) {
    const retryableProviderFailure =
      providerIdempotent &&
      error instanceof IMessageError &&
      error.retryable === true;
    const providerFailure = failure(
      command.commandId,
      retryableProviderFailure ? "retryable_provider" : "permanent_provider",
      error instanceof Error ? error.message : "provider send failed",
      retryableProviderFailure,
    );
    if (retryableProviderFailure) {
      await runApp(releaseIMessageCommand(command));
    } else {
      // Common Spectrum primitives do not expose a provider idempotency key.
      // Completing the failure is safer than an automatic retry that could
      // duplicate a send whose response was lost.
      await runApp(completeIMessageCommand(command, providerFailure));
    }
    return {
      status: 502,
      result: providerFailure,
    };
  }

  if (result.ok) {
    // Poll votes must be resolvable before the command is marked complete. If
    // this side effect fails, the still-pending idempotent command is safely
    // replayed instead of returning a poll that can never resume Ruth.
    await registerPollBindingBeforeCompletion({
      command,
      executedCommand,
      result,
      ownerHandle: actor.handle,
    });
  }
  await runApp(completeIMessageCommand(command, result));
  if (result.ok) {
    await runApp(
      recordIMessageLineSend({
        phone: command.phone,
        newConversation: command.operation === "create_group",
      }),
    );
    await ensureLocationWorkflow(command, actor.handle, actor.deploymentUrl);
  }
  await runApp(
    auditIMessageSecurity({
      actionCategory: command.operation,
      actorRole: command.actor.role,
      targetType: command.target.kind,
      decision: result.ok ? "allowed" : "failed",
    }),
  );
  return { status: result.ok ? 200 : 422, result };
}
