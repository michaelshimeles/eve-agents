import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryStore } from "../lib/memory-store";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description:
    "List every saved long-term memory entry with its id. Use to review what is saved, or to find the id needed to delete one with forget.",
  inputSchema: z.object({}),
  async execute() {
    const memories = await memoryStore.list();
    return { memories };
  },
});
