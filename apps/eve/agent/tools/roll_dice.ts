import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Roll one or more dice. Use for games, random picks, or whenever chance is called for.",
  inputSchema: z.object({
    count: z.number().int().min(1).max(20).default(1).describe("How many dice to roll"),
    sides: z.number().int().min(2).max(1000).default(6).describe("Sides per die"),
  }),
  execute({ count, sides }) {
    const rolls = Array.from(
      { length: count },
      () => Math.floor(Math.random() * sides) + 1,
    );
    return {
      rolls,
      total: rolls.reduce((sum, roll) => sum + roll, 0),
      dice: `${count}d${sides}`,
    };
  },
});
