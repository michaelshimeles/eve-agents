import { defineTool } from "eve/tools";
import { z } from "zod";
import { skillStore } from "../lib/skill-store";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description:
    "Delete one of the user's saved skills by name. Use when the user asks to remove a skill or a saved procedure is obsolete.",
  inputSchema: z.object({
    name: z.string().min(1).max(50).describe("The name of the skill to delete"),
  }),
  async execute({ name }) {
    const deleted = await skillStore.delete(name);
    return { deleted };
  },
});
