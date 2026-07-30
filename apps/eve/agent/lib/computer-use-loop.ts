import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";

// Shared screenshot/action loop for every computer backend. Providers own how
// an action reaches a machine; this service owns the repeatable AI mechanics:
// one typed action, a fresh screenshot after it, bounded steps, cancellation,
// and a compact completion result.

export const computerActionSchema = z.object({
  action: z
    .enum(["screenshot", "click", "drag", "type", "key", "scroll", "wait", "bash"])
    .describe("The single computer action to perform."),
  x: z.number().int().nonnegative().optional().describe("Click x coordinate in pixels."),
  y: z.number().int().nonnegative().optional().describe("Click y coordinate in pixels."),
  start_x: z.number().int().nonnegative().optional().describe("Drag start x coordinate."),
  start_y: z.number().int().nonnegative().optional().describe("Drag start y coordinate."),
  end_x: z.number().int().nonnegative().optional().describe("Drag end x coordinate."),
  end_y: z.number().int().nonnegative().optional().describe("Drag end y coordinate."),
  button: z.enum(["left", "right"]).optional().describe("Mouse button; defaults to left."),
  double: z.boolean().optional().describe("Double-click when action is click."),
  text: z
    .string()
    .max(20_000)
    .optional()
    .describe("Literal text to type when action is type."),
  key: z
    .string()
    .max(100)
    .optional()
    .describe("Key or shortcut, e.g. Enter, Tab, cmd+l, or ctrl+c."),
  direction: z.enum(["up", "down"]).optional().describe("Scroll direction."),
  amount: z.number().int().min(1).max(20).optional().describe("Scroll amount; defaults to 3."),
  seconds: z.number().min(0).max(60).optional().describe("Seconds to wait."),
  command: z.string().max(20_000).optional().describe("Shell command to run on the computer."),
});

export type ComputerAction = z.infer<typeof computerActionSchema>;

export interface ComputerActionResult {
  readonly message: string;
  readonly screenshotBase64: string;
}

export interface ComputerUseLoopResult {
  readonly status: "completed" | "stopped_early";
  readonly text: string;
  readonly steps: number | null;
}

export function requiredActionNumber(
  action: ComputerAction,
  field: "x" | "y" | "start_x" | "start_y" | "end_x" | "end_y",
): number {
  const value = action[field];
  if (value === undefined) throw new Error(`${action.action} requires ${field}.`);
  return value;
}

export function requiredActionString(
  action: ComputerAction,
  field: "text" | "key" | "command",
): string {
  const raw = action[field];
  const value = field === "text" ? raw : raw?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${action.action} requires ${field}.`);
  }
  return value;
}

export async function runComputerUseLoop(input: {
  readonly instruction: string;
  readonly modelId: string;
  readonly instructions: string;
  readonly toolDescription: string;
  readonly initialScreenshot: (signal: AbortSignal) => Promise<string>;
  readonly executeAction: (
    action: ComputerAction,
    signal: AbortSignal,
  ) => Promise<ComputerActionResult>;
  readonly maxSteps?: number;
  readonly timeoutSeconds: number;
  readonly timeoutMessage: string;
  readonly signal?: AbortSignal;
}): Promise<ComputerUseLoopResult> {
  const controller = new AbortController();
  const stopOnCancel = (): void => controller.abort(input.signal?.reason);
  if (input.signal?.aborted === true) stopOnCancel();
  else input.signal?.addEventListener("abort", stopOnCancel, { once: true });
  const deadline = setTimeout(() => controller.abort(), input.timeoutSeconds * 1_000);
  const maxSteps = input.maxSteps ?? 100;

  const computerTool = tool({
    description: input.toolDescription,
    inputSchema: computerActionSchema,
    async execute(action, { abortSignal }) {
      return await input.executeAction(action, abortSignal ?? controller.signal);
    },
    toModelOutput({ output }) {
      return {
        type: "content",
        value: [
          { type: "text", text: output.message },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: output.screenshotBase64 },
          },
        ],
      };
    },
  });

  try {
    const initialScreenshot = await input.initialScreenshot(controller.signal);
    const agent = new ToolLoopAgent({
      model: input.modelId,
      instructions: input.instructions,
      tools: { computer: computerTool },
      stopWhen: isStepCount(maxSteps),
    });
    const result = await agent.generate({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: input.instruction },
            { type: "file", mediaType: "image/png", data: initialScreenshot },
          ],
        },
      ],
      abortSignal: controller.signal,
    });
    const text = result.text.trim();
    const stoppedEarly = text.length === 0 && result.steps.length >= maxSteps;
    return {
      status: stoppedEarly ? "stopped_early" : "completed",
      text:
        text.length > 0
          ? text
          : "The selected model stopped after operating the computer without a final report.",
      steps: result.steps.length,
    };
  } catch (error) {
    const cutShort =
      controller.signal.aborted &&
      input.signal?.aborted !== true &&
      error instanceof Error &&
      error.name === "AbortError";
    if (!cutShort) throw error;
    return {
      status: "stopped_early",
      text: input.timeoutMessage,
      steps: null,
    };
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", stopOnCancel);
  }
}
