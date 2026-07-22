import { defineTool } from "eve/tools";
import { z } from "zod";
import { db } from "../lib/receipts-db";

const GROUPINGS = {
  category: "category",
  merchant: "merchant",
  month: "to_char(purchased_at, 'YYYY-MM')",
} as const;

export default defineTool({
  description:
    "Total spending grouped by category, merchant, or month, with an overall total. Use for questions like 'how much did I spend on groceries this year' or 'break down my July spending'.",
  inputSchema: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Earliest purchase date, inclusive"),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Latest purchase date, inclusive"),
    group_by: z.enum(["category", "merchant", "month"]).default("category"),
  }),
  async execute({ from, to, group_by }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (from) {
      params.push(from);
      where.push(`purchased_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      where.push(`purchased_at <= $${params.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const groupExpr = GROUPINGS[group_by];

    const groups = await db().query(
      `SELECT ${groupExpr} AS "group",
              round(sum(total_cents) / 100.0, 2)::float8 AS total,
              count(*)::int AS receipts
       FROM receipts ${whereSql}
       GROUP BY 1 ORDER BY 2 DESC`,
      params,
    );
    const overall = await db().query(
      `SELECT coalesce(round(sum(total_cents) / 100.0, 2), 0)::float8 AS total, count(*)::int AS receipts
       FROM receipts ${whereSql}`,
      params,
    );

    return { groups, overall: overall[0] };
  },
});
