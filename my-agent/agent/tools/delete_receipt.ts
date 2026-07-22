import { defineTool } from "eve/tools";
import { z } from "zod";
import { db } from "../lib/receipts-db";

export default defineTool({
  description:
    "Delete one logged receipt by its id. Use to correct a mistaken or duplicate entry; find the id with query_receipts first.",
  inputSchema: z.object({
    id: z.number().int().positive().describe("Receipt id from query_receipts"),
  }),
  async execute({ id }) {
    const rows = await db().query("DELETE FROM receipts WHERE id = $1 RETURNING id", [id]);
    return { deleted: rows.length > 0 };
  },
});
