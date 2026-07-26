import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { isSchemaError } from "effect/SchemaError";

import { AgentcardError, AgentcardLive, describeAgentcardError } from "./agentcard";
import { DatabaseError, DbLive, describeDatabaseError } from "./db";
import { ReceiptsLive } from "./receipts";
import { RemotionLive, VideoRenderError, describeVideoRenderError } from "./remotion";

// One composition root for the agent's Effect services. The runtime is
// created lazily on first use (eve evaluates authored modules at build time,
// where DATABASE_URL may be absent) and shared across tool calls, so layers
// are built once per process.

const AppLayer = Layer.mergeAll(
  DbLive,
  AgentcardLive.pipe(Layer.provide(DbLive)),
  ReceiptsLive.pipe(Layer.provide(DbLive)),
  RemotionLive,
);

export type AppServices = Layer.Success<typeof AppLayer>;

export const runtime = ManagedRuntime.make(AppLayer);

/** Renders a failure as one model-readable line, without a fiber trace. */
function describeFailure(cause: Cause.Cause<unknown>): string {
  const failure = Cause.squash(cause);
  if (failure instanceof AgentcardError) return describeAgentcardError(failure);
  if (failure instanceof DatabaseError) return describeDatabaseError(failure);
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
