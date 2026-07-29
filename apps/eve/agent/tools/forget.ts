import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryStore } from "../lib/memory-store";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description:
    "Delete one long-term memory by its id. Use when the user asks you to forget something or a saved fact is no longer true. Find the id with search_memory or list_memories first.",
  inputSchema: z.object({
    memoryId: z.string().min(1).describe("The id of the memory to delete, from search_memory or list_memories"),
  }),
  async execute({ memoryId }) {
    const deleted = await memoryStore.delete(memoryId);
    return { deleted };
  },
});
