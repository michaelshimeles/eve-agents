import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryStore } from "../lib/memory-store";

export default defineTool({
  description:
    "List every saved long-term memory entry with its id. Use to review what is saved, or to find the id needed to delete one with forget.",
  inputSchema: z.object({}),
  async execute() {
    const memories = await memoryStore.list();
    return { memories };
  },
});
