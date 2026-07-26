import { defineTool } from "eve/tools";

import { QueryReceiptsInput, queryReceipts } from "../lib/effect/receipts";
import { runTool } from "../lib/effect/runtime";
import { toolSchema } from "../lib/effect/tool-schema";

export default defineTool({
  description:
    "List logged receipts with optional filters, newest first, including the filtered total. Use for questions like 'what did I spend at Loblaws' or 'show my dining expenses this month'.",
  inputSchema: toolSchema(QueryReceiptsInput),
  execute(input) {
    return runTool(queryReceipts(input));
  },
});
