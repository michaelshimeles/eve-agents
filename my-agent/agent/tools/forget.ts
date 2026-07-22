import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryStore } from "../lib/memory-store";

export default defineTool({
  description:
    "Delete one long-term memory by its key. Use when the user asks you to forget something or a saved fact is no longer true.",
  inputSchema: z.object({
    key: z.string().min(1).max(80).describe("The key of the memory to delete"),
  }),
  async execute({ key }) {
    const deleted = await memoryStore.delete(key);
    return { deleted };
  },
});
