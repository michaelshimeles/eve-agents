import { defineTool } from "eve/tools";

import { SpendingSummaryInput, spendingSummary } from "../lib/effect/receipts";
import { runTool } from "../lib/effect/runtime";
import { toolSchema } from "../lib/effect/tool-schema";

export default defineTool({
  description:
    "Total spending grouped by category, merchant, or month, with an overall total. Use for questions like 'how much did I spend on groceries this year' or 'break down my July spending'.",
  inputSchema: toolSchema(SpendingSummaryInput),
  execute(input) {
    return runTool(spendingSummary(input));
  },
});
