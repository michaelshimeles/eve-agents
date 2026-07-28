import { defineTool } from "eve/tools";

import { LogReceiptInput, logReceipt } from "../lib/effect/receipts";
import { runTool } from "../lib/effect/runtime";
import { toolSchema } from "../lib/effect/tool-schema";
import { ownerOnly } from "../lib/owner-gate";

export default defineTool({
  approval: ownerOnly,
  description:
    "Log a purchase receipt to the expense database. Use when the user sends a receipt photo (extract the fields from the image) or describes a purchase to log. Amounts are in dollars.",
  inputSchema: toolSchema(LogReceiptInput),
  execute(input) {
    return runTool(logReceipt(input));
  },
});
