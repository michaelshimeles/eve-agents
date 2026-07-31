import { createMCPClient, type CallToolResult, type MCPClient } from "@ai-sdk/mcp";
import { Context, Data, Effect, Layer, Schema } from "effect";

import {
  type ComputerAction,
  type ComputerActionResult,
  requiredActionNumber,
  requiredActionString,
  runComputerUseLoop,
} from "../computer-use-loop";
import { parseLocalComputerMcpUrl } from "../local-computer-url";

const DEFAULT_LOCAL_MODEL = "anthropic/claude-sonnet-5";
const DEFAULT_TASK_TIMEOUT_SECONDS = 240;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

export const LocalComputerTaskInput = Schema.Struct({
  instruction: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20_000),
  ).annotate({
    description:
      "Complete goal for Ruth's real Mac, including any consequential action the owner explicitly authorized.",
  }),
  max_steps: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 150 }),
  )
    .annotate({
      description: "Maximum screenshot-and-action cycles. Defaults to 100.",
    })
    .pipe(Schema.optionalKey),
});
export type LocalComputerTaskInput = typeof LocalComputerTaskInput.Type;

export interface LocalComputerTaskResult {
  readonly status: "completed" | "stopped_early";
  readonly result: string;
  readonly steps: number | null;
  readonly model: string;
}

export class LocalComputerError extends Data.TaggedError("LocalComputerError")<{
  readonly reason: "not_configured" | "connection" | "tool" | "model";
  readonly detail: string;
}> {}

export function describeLocalComputerError(error: LocalComputerError): string {
  switch (error.reason) {
    case "not_configured":
      return `Ruth Local is not configured: ${error.detail}`;
    case "connection":
      return `Ruth Local is offline: ${error.detail}`;
    case "tool":
      return `Ruth Local refused the operation: ${error.detail}`;
    case "model":
      return `The local computer-use model failed: ${error.detail}`;
  }
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export function localComputerConfigured(): boolean {
  return (
    env("RUTH_LOCAL_MCP_URL") !== undefined &&
    (env("RUTH_LOCAL_MCP_TOKEN")?.length ?? 0) >= 32
  );
}

function localModel(): string {
  const model = env("RUTH_LOCAL_COMPUTER_MODEL") ?? DEFAULT_LOCAL_MODEL;
  if (!MODEL_ID.test(model)) {
    throw new LocalComputerError({
      reason: "not_configured",
      detail: "RUTH_LOCAL_COMPUTER_MODEL must look like provider/model.",
    });
  }
  return model;
}

function taskTimeoutSeconds(): number {
  const raw = env("RUTH_LOCAL_TASK_TIMEOUT_SECONDS");
  if (raw === undefined) return DEFAULT_TASK_TIMEOUT_SECONDS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 10 || parsed > 600) {
    throw new LocalComputerError({
      reason: "not_configured",
      detail: "RUTH_LOCAL_TASK_TIMEOUT_SECONDS must be an integer from 10 to 600.",
    });
  }
  return parsed;
}

function connectionConfig(): { url: string; headers: Record<string, string> } {
  const rawUrl = env("RUTH_LOCAL_MCP_URL");
  const token = env("RUTH_LOCAL_MCP_TOKEN");
  if (rawUrl === undefined || token === undefined || token.length < 32) {
    throw new LocalComputerError({
      reason: "not_configured",
      detail: "set RUTH_LOCAL_MCP_URL and a token of at least 32 characters.",
    });
  }
  let url: URL;
  try {
    url = parseLocalComputerMcpUrl(rawUrl);
  } catch (cause) {
    throw new LocalComputerError({
      reason: "not_configured",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const accessId = env("RUTH_LOCAL_CF_ACCESS_CLIENT_ID");
  const accessSecret = env("RUTH_LOCAL_CF_ACCESS_CLIENT_SECRET");
  if ((accessId === undefined) !== (accessSecret === undefined)) {
    throw new LocalComputerError({
      reason: "not_configured",
      detail: "set both Cloudflare Access service-token fields, or neither.",
    });
  }
  return {
    url: url.href,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(accessId === undefined
        ? {}
        : {
            "CF-Access-Client-Id": accessId,
            "CF-Access-Client-Secret": accessSecret!,
          }),
    },
  };
}

async function createClient(): Promise<MCPClient> {
  const config = connectionConfig();
  try {
    return await createMCPClient({
      clientName: "ruth-local-computer-use",
      maxRetries: 1,
      transport: {
        type: "http",
        url: config.url,
        headers: config.headers,
      },
    });
  } catch (cause) {
    throw new LocalComputerError({
      reason: "connection",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function toolErrorMessage(result: CallToolResult): string {
  if ("toolResult" in result) return JSON.stringify(result.toolResult).slice(0, 2_000);
  const text = result.content
    .filter(
      (
        item,
      ): item is Extract<(typeof result.content)[number], { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
  return text.length === 0 ? "unknown tool failure" : text.slice(0, 2_000);
}

async function callTool(
  client: MCPClient,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CallToolResult> {
  let result: CallToolResult;
  try {
    result = await client.callTool({
      name,
      arguments: args,
      options: { signal, timeout: 120_000, maxTotalTimeout: 180_000 },
    });
  } catch (cause) {
    throw new LocalComputerError({
      reason: "connection",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if ("isError" in result && result.isError === true) {
    throw new LocalComputerError({ reason: "tool", detail: toolErrorMessage(result) });
  }
  return result;
}

function screenshotFromResult(result: CallToolResult): string {
  if ("toolResult" in result) {
    throw new LocalComputerError({
      reason: "tool",
      detail: "the bridge returned no screenshot image.",
    });
  }
  const image = result.content.find(
    (item): item is Extract<(typeof result.content)[number], { type: "image" }> =>
      item.type === "image" && item.mimeType === "image/png",
  );
  if (image === undefined || image.data.length === 0) {
    throw new LocalComputerError({
      reason: "tool",
      detail: "the bridge returned no PNG screenshot.",
    });
  }
  return image.data;
}

function textFromResult(result: CallToolResult): string {
  if ("toolResult" in result) return JSON.stringify(result.toolResult).slice(0, 8_000);
  const text = result.content
    .filter(
      (
        item,
      ): item is Extract<(typeof result.content)[number], { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
  return text.slice(0, 8_000);
}

const LOCAL_COMPUTER_INSTRUCTIONS = `You control the owner's real macOS computer using the computer tool.
The first message includes the current main-display screenshot. Every action result includes a fresh screenshot.

Rules:
- The outer owner already approved the displayed task instruction. Work only toward that instruction.
- Work one clear action at a time and inspect the returned screenshot before choosing the next action.
- Coordinates are pixels in the screenshot, with (0, 0) at the top-left.
- Use bash for exact shell work and GUI actions for visible app state. You have the logged-in user's privileges.
- Existing browser and app sessions may already be signed in. Never reveal passwords, tokens, private keys, or authentication data in your final report.
- Do not expand the approved task into purchases, messages, publishing, account or security changes, identity sharing, permanent deletion, or another consequential action unless the instruction explicitly authorizes it.
- Do not claim success until you have visually or deterministically verified the requested result.
- Finish with a concise report of what changed and any result the owner needs.`;

async function executeLocalAction(
  client: MCPClient,
  action: ComputerAction,
  signal: AbortSignal,
): Promise<ComputerActionResult> {
  if (action.action === "screenshot") {
    const result = await callTool(client, "computer_screenshot", {}, signal);
    return {
      message: "Captured a fresh screenshot.",
      screenshotBase64: screenshotFromResult(result),
    };
  }
  if (action.action === "bash") {
    const result = await callTool(
      client,
      "shell",
      { command: requiredActionString(action, "command"), timeout_seconds: 120 },
      signal,
    );
    const screenshot = await callTool(client, "computer_screenshot", {}, signal);
    const output = textFromResult(result);
    return {
      message: `Local zsh finished.${output.length === 0 ? "" : `\n${output}`}`,
      screenshotBase64: screenshotFromResult(screenshot),
    };
  }

  const args: Record<string, unknown> = { action: action.action };
  if (action.action === "click") {
    args.x = requiredActionNumber(action, "x");
    args.y = requiredActionNumber(action, "y");
    if (action.button !== undefined) args.button = action.button;
    if (action.double !== undefined) args.double = action.double;
  } else if (action.action === "drag") {
    args.start_x = requiredActionNumber(action, "start_x");
    args.start_y = requiredActionNumber(action, "start_y");
    args.end_x = requiredActionNumber(action, "end_x");
    args.end_y = requiredActionNumber(action, "end_y");
    if (action.button !== undefined) args.button = action.button;
  } else if (action.action === "type") {
    args.text = requiredActionString(action, "text");
  } else if (action.action === "key") {
    args.key = requiredActionString(action, "key");
  } else if (action.action === "scroll") {
    if (action.direction === undefined) throw new Error("scroll requires direction.");
    args.direction = action.direction;
    if (action.amount !== undefined) args.amount = action.amount;
  } else {
    args.seconds = action.seconds ?? 1;
  }

  const result = await callTool(client, "computer_action", args, signal);
  return {
    message: textFromResult(result),
    screenshotBase64: screenshotFromResult(result),
  };
}

async function runTask(
  input: LocalComputerTaskInput,
  signal?: AbortSignal,
): Promise<LocalComputerTaskResult> {
  const model = localModel();
  const client = await createClient();
  try {
    const result = await runComputerUseLoop({
      instruction: input.instruction,
      modelId: model,
      instructions: LOCAL_COMPUTER_INSTRUCTIONS,
      toolDescription:
        "Inspect or operate the owner's real Mac. Perform one action per call. Every result includes the new screenshot.",
      initialScreenshot: async (activeSignal) =>
        screenshotFromResult(
          await callTool(client, "computer_screenshot", {}, activeSignal),
        ),
      executeAction: (action, activeSignal) =>
        executeLocalAction(client, action, activeSignal),
      timeoutSeconds: taskTimeoutSeconds(),
      timeoutMessage:
        "The local computer task reached its time limit. The Mac remains exactly where the last action left it.",
      ...(input.max_steps === undefined ? {} : { maxSteps: input.max_steps }),
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      status: result.status,
      result: result.text,
      steps: result.steps,
      model,
    };
  } catch (cause) {
    if (cause instanceof LocalComputerError) throw cause;
    throw new LocalComputerError({
      reason: "model",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export class LocalComputer extends Context.Service<LocalComputer, {
  readonly task: (
    input: LocalComputerTaskInput,
    signal?: AbortSignal,
  ) => Effect.Effect<LocalComputerTaskResult, LocalComputerError>;
}>()("LocalComputer") {}

export const LocalComputerLive = Layer.succeed(LocalComputer, {
  task: (input, signal) =>
    Effect.tryPromise({
      try: () => runTask(input, signal),
      catch: (cause) =>
        cause instanceof LocalComputerError
          ? cause
          : new LocalComputerError({
              reason: "model",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
    }),
});

export const localComputerTask = (
  input: LocalComputerTaskInput,
  signal?: AbortSignal,
): Effect.Effect<LocalComputerTaskResult, LocalComputerError, LocalComputer> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputer).task(input, signal);
  });
