import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { isSchemaError } from "effect/SchemaError";

import { AnonymousEveRateLimitLive } from "./anonymous-eve-rate-limit";
import { AgentPhoneError, AgentPhoneLive, describeAgentPhoneError } from "./agentphone";
import { AgentcardError, AgentcardStoreLive, describeAgentcardError } from "./agentcard";
import { AgentcardConnectLive } from "./agentcard-connect";
import { ArtifactError, ArtifactsLive, describeArtifactError } from "./artifacts";
import { ChatFileError, ChatFilesLive, describeChatFileError } from "./chat-files";
import { DatabaseError, DbLive, describeDatabaseError } from "./db";
import { IMessageError, IMessagePairingLive, IMessageRouterLive, describeIMessageError } from "./imessage";
import {
  IMessageRichStoreLive,
  IMessageStoreError,
} from "./imessage/store";
import { IMessageMediaError } from "./imessage/media";
import { LocalComputerError, LocalComputerLive, describeLocalComputerError } from "./local-computer";
import {
  LocalComputerRelayError,
  LocalComputerRelayLive,
  describeLocalComputerRelayError,
} from "./local-computer-relay";
import { ReceiptsLive } from "./receipts";
import { RemotionLive, VideoRenderError, describeVideoRenderError } from "./remotion";
import {
  SandboxWorkspaceError,
  SandboxWorkspaceLive,
} from "./sandbox-workspace";

// One composition root for the agent's Effect services. The runtime is
// created lazily on first use (eve evaluates authored modules at build time,
// where DATABASE_URL may be absent) and shared across tool calls, so layers
// are built once per process.

const AgentcardStoreWired = AgentcardStoreLive.pipe(Layer.provide(DbLive));
const AgentcardSelectedLive = AgentcardConnectLive.pipe(Layer.provide(AgentcardStoreWired));
const LocalComputerRelayWired = LocalComputerRelayLive.pipe(Layer.provide(DbLive));

const AppLayer = Layer.mergeAll(
  DbLive,
  AnonymousEveRateLimitLive.pipe(Layer.provide(DbLive)),
  AgentPhoneLive.pipe(Layer.provide(DbLive)),
  AgentcardSelectedLive,
  ArtifactsLive.pipe(Layer.provide(DbLive)),
  ChatFilesLive.pipe(Layer.provide(DbLive)),
  ReceiptsLive.pipe(Layer.provide(DbLive)),
  IMessagePairingLive.pipe(Layer.provide(DbLive)),
  IMessageRouterLive.pipe(Layer.provide(DbLive)),
  IMessageRichStoreLive.pipe(Layer.provide(DbLive)),
  LocalComputerRelayWired,
  LocalComputerLive.pipe(Layer.provide(LocalComputerRelayWired)),
  RemotionLive,
  SandboxWorkspaceLive,
);

export type AppServices = Layer.Success<typeof AppLayer>;

export const runtime = ManagedRuntime.make(AppLayer);

/** Renders a failure as one model-readable line, without a fiber trace. */
function describeFailure(cause: Cause.Cause<unknown>): string {
  const failure = Cause.squash(cause);
  if (failure instanceof AgentPhoneError) return describeAgentPhoneError(failure);
  if (failure instanceof AgentcardError) return describeAgentcardError(failure);
  if (failure instanceof ArtifactError) return describeArtifactError(failure);
  if (failure instanceof ChatFileError) return describeChatFileError(failure);
  if (failure instanceof DatabaseError) return describeDatabaseError(failure);
  if (failure instanceof IMessageError) return describeIMessageError(failure);
  if (failure instanceof IMessageStoreError) return failure.detail;
  if (failure instanceof IMessageMediaError) return failure.detail;
  if (failure instanceof LocalComputerError) return describeLocalComputerError(failure);
  if (failure instanceof LocalComputerRelayError) {
    return describeLocalComputerRelayError(failure);
  }
  if (failure instanceof SandboxWorkspaceError) return failure.message;
  if (failure instanceof VideoRenderError) return describeVideoRenderError(failure);
  if (isSchemaError(failure)) return `Invalid data: ${failure.message}`;
  if (failure instanceof Error) return failure.message;
  return String(failure);
}

/**
 * Runs an Effect program at an eve tool boundary. Typed failures become a
 * plain `Error` with a concise message — eve reports that to the model, which
 * can react (retry, correct input, tell the user) like with any tool error.
 */
export async function runTool<A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(describeFailure(exit.cause));
}

/** Runs an Effect program at a Next.js route boundary with the shared app layer. */
export function runApp<A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> {
  // Route adapters need the original tagged domain error so they can map it
  // to the correct HTTP status without exposing provider or credential detail.
  return runtime.runPromise(effect);
}
