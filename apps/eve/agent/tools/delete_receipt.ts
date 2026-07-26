import { Schema } from "effect";
import { defineTool } from "eve/tools";

import { deleteReceipt } from "../lib/effect/receipts";
import { runTool } from "../lib/effect/runtime";
import { toolSchema } from "../lib/effect/tool-schema";

export default defineTool({
  description:
    "Delete one logged receipt by its id. Use to correct a mistaken or duplicate entry; find the id with query_receipts first.",
  inputSchema: toolSchema(
    Schema.Struct({
      id: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
        description: "Receipt id from query_receipts",
      }),
    }),
  ),
  execute({ id }) {
    return runTool(deleteReceipt(id));
  },
});
