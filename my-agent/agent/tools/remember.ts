import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryStore } from "../lib/memory-store";

export default defineTool({
  description:
    "Save or update one long-term memory that persists across all future conversations. Use for durable facts and preferences about the user (name, city, habits, likes, ongoing projects). Never save secrets, passwords, tokens, or payment details.",
  inputSchema: z.object({
    key: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9_.-]+$/)
      .describe("Stable snake_case identifier, e.g. 'home_city' or 'coffee_order'"),
    value: z.string().min(1).max(4000).describe("The fact to remember, phrased plainly"),
  }),
  async execute({ key, value }) {
    return await memoryStore.put(key, value);
  },
});
