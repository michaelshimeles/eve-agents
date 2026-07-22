import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryStore } from "../lib/memory-store";

export default defineTool({
  description:
    "Search long-term memory for saved facts and past context relevant to a query. Use when the user references something not covered by the memory profile injected into this turn.",
  inputSchema: z.object({
    query: z.string().min(1).max(500).describe("What to look for, phrased as a plain question or topic"),
  }),
  async execute({ query }) {
    const results = await memoryStore.search(query);
    return { results };
  },
});
