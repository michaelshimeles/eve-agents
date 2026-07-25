import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { orgo, orgoConfigured } from "../lib/orgo";
import { ownerName } from "../lib/owner";

// A persistent cloud desktop (Orgo) the agent can actually use: a Linux VM with
// a display, a browser, and a shell that keeps its disk between conversations.
//
// Registered dynamically so a deployment without ORGO_API_KEY advertises none
// of it — every tool schema ships with every model call, and four dead tools
// plus instructions for a computer that isn't there is worse than nothing.
//
// Two ways in, because they have different costs:
//   - computer_task pays a vision model to look at the screen and act, which is
//     the only way anything graphical gets done (eve tool results are text, so
//     a screenshot can never reach our own model as an image), and
//   - computer_bash is one HTTP call with no model in the loop, which is both
//     cheaper and exact for anything a shell can do.

const MAX_OUTPUT_CHARS = 20_000;

function truncate(output: string): { output: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_CHARS) return { output, truncated: false };
  return { output: `${output.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]`, truncated: true };
}

export default defineDynamic({
  events: {
    "session.started": async () => {
      if (!(await orgoConfigured())) return null;
      const owner = ownerName();

      return {
        computer_task: defineTool({
          description:
            "Do something on your cloud desktop that needs eyes on the screen: open apps, click through a site, fill a form, read what is displayed. A computer-use model takes the screen, acts, and repeats until your instruction is done, then reports back. Write the instruction like you would for a capable person seeing the desktop for the first time: the goal, anything it needs to know, and what to report. Prefer computer_bash for anything a shell can do; it is far cheaper. The desktop is provisioned on first use and keeps its files, logins, and installed apps.",
          inputSchema: z.object({
            instruction: z
              .string()
              .min(1)
              .describe(
                'What to accomplish on the desktop, e.g. "Open Firefox, go to news.ycombinator.com, and tell me the top three story titles."',
              ),
            continue_thread_id: z
              .string()
              .optional()
              .describe(
                "threadId from an earlier computer_task, to continue that session with its full context. Use this to resume a task that stopped early or to build on what it just did.",
              ),
            model: z
              .enum(["sonnet", "opus"])
              .optional()
              .describe("Desktop model. Defaults to sonnet; use opus for long or fiddly tasks."),
            max_steps: z
              .number()
              .int()
              .min(1)
              .max(150)
              .optional()
              .describe("Cap on screenshot-and-act cycles. Raise it for multi-stage work."),
          }),
          async execute({ instruction, continue_thread_id, model, max_steps }, ctx) {
            const result = await orgo.task({
              instruction,
              ...(continue_thread_id === undefined ? {} : { threadId: continue_thread_id }),
              ...(model === undefined ? {} : { model }),
              ...(max_steps === undefined ? {} : { maxSteps: max_steps }),
              ...(ctx.abortSignal === undefined ? {} : { signal: ctx.abortSignal }),
            });

            const note =
              result.status === "stopped_early"
                ? "The task hit its time limit and was stopped; the desktop is left exactly as it was. Call computer_task again with continue_thread_id to pick up where it left off."
                : result.text.length === 0
                  ? "The run ended without reporting anything. Take a screenshot to see where the desktop landed before retrying."
                  : null;

            // Run metadata only rides along on Orgo's non-streaming responses;
            // leave it out entirely rather than showing the model empty fields.
            return {
              status: result.status,
              result: result.text,
              threadId: result.threadId,
              ...(result.steps === null ? {} : { steps: result.steps }),
              ...(result.costCents === null ? {} : { costCents: result.costCents }),
              ...(note === null ? {} : { note }),
            };
          },
        }),

        computer_bash: defineTool({
          description:
            "Run a bash command on your cloud desktop and get its output. This is the cheap, exact path: files, installs (apt/pip/npm), git, curl, scripts, launching an app on the desktop's display. No screen involved, so use computer_task when you need to see what happened. Python: run `python3 -c '…'`.",
          inputSchema: z.object({
            command: z.string().min(1).describe("Bash command, e.g. `ls -la ~ && free -h`."),
            timeout_seconds: z
              .number()
              .int()
              .min(1)
              .max(600)
              .optional()
              .describe("Kill the command after this long. Use it for anything slow."),
          }),
          async execute({ command, timeout_seconds }, ctx) {
            const result = await orgo.bash(command, {
              ...(timeout_seconds === undefined ? {} : { timeoutSeconds: timeout_seconds }),
              ...(ctx.abortSignal === undefined ? {} : { signal: ctx.abortSignal }),
            });
            const { output, truncated } = truncate(result.output);
            return {
              exitCode: result.exitCode,
              output,
              ...(truncated ? { truncated: true } : {}),
            };
          },
        }),

        computer_screenshot: defineTool({
          description: `Capture the cloud desktop's screen and get an image URL. You cannot see the image yourself, so use this to show ${owner} what is on screen - hand him the URL as a markdown image. To have something on screen read or acted on, use computer_task instead.`,
          inputSchema: z.object({}),
          async execute(_input, ctx) {
            const result = await orgo.screenshot(ctx.abortSignal);
            if (result.imageUrl === null) {
              return {
                imageUrl: null,
                liveViewUrl: result.computer.liveViewUrl,
                note: `The screenshot came back inline instead of as a URL${result.inlineBytes === null ? "" : ` (${result.inlineBytes} bytes)`}, so there is nothing to link. Send ${owner} the live view URL instead.`,
              };
            }
            return {
              imageUrl: result.imageUrl,
              liveViewUrl: result.computer.liveViewUrl,
              note: `Show it to ${owner} as a markdown image: ![desktop](URL). You cannot see it yourself.`,
            };
          },
        }),

        computer_control: defineTool({
          description:
            "Check or change the cloud desktop itself: current status, its live view URL (the owner can watch and take over there), and start / stop / restart. Stopping keeps the disk, so files and logins survive. You do not need this before other computer tools - they start the desktop on their own.",
          inputSchema: z.object({
            action: z
              .enum(["status", "start", "stop", "restart"])
              .describe(
                "status and stop/restart never provision a desktop; start creates one if there is none.",
              ),
          }),
          async execute({ action }, ctx) {
            const signal = ctx.abortSignal;
            const computer =
              action === "start"
                ? await orgo.start(signal)
                : action === "stop"
                  ? await orgo.stop(signal)
                  : action === "restart"
                    ? await orgo.restart(signal)
                    : await orgo.status(signal);

            if (computer === null) {
              return {
                provisioned: false as const,
                note: "No desktop exists yet. It is created the first time you use computer_task, computer_bash, or computer_screenshot, or now with action 'start'.",
              };
            }

            return {
              provisioned: true as const,
              name: computer.name,
              // Orgo reports an idle desktop as "frozen"; its disk is intact.
              status: computer.status,
              ...(computer.status === "running"
                ? {}
                : { note: "Not running right now. Any computer tool wakes it automatically." }),
              liveViewUrl: computer.liveViewUrl,
              specs:
                computer.ram === null || computer.cpu === null
                  ? null
                  : `${computer.ram} GB RAM / ${computer.cpu} CPU`,
              resolution: computer.resolution,
            };
          },
        }),
      };
    },
  },
});
