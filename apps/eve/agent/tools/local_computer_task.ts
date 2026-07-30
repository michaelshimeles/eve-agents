import { defineDynamic, defineTool } from "eve/tools";
import type { Approval } from "eve/tools";

import {
  LocalComputerTaskInput,
  localComputerConfigured,
  localComputerTask,
} from "../lib/effect/local-computer";
import { runTool } from "../lib/effect/runtime";
import { isGuestResolve, guestDenial } from "../lib/owner-gate";
import { toolSchema } from "../lib/effect/tool-schema";

export const localComputerTaskApproval: Approval = (context) =>
  guestDenial(context) ?? "user-approval";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (isGuestResolve(ctx) || !localComputerConfigured()) return null;
      return {
        local_computer_task: defineTool({
          description:
            "Hand one complete task to a vision model controlling the owner's real Mac. After the owner approves the instruction once, it can repeatedly see the main display, click, drag, type, press shortcuts, scroll, wait, and run arbitrary zsh until the task is complete. Use this for GUI work or multi-step local-computer work. The Mac must be awake, unlocked, running Ruth Local, and have Accessibility plus Screen Recording permission.",
          inputSchema: toolSchema(LocalComputerTaskInput),
          approval: localComputerTaskApproval,
          async execute(input, toolContext) {
            return runTool(localComputerTask(input, toolContext.abortSignal));
          },
        }),
      };
    },
  },
});
