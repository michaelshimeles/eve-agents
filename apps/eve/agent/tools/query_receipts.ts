import { defineTool } from "eve/tools";
import { z } from "zod";
import { RECEIPT_CATEGORIES, RECEIPT_PROJECTION, db } from "../lib/receipts-db";

export default defineTool({
  description:
    "List logged receipts with optional filters, newest first, including the filtered total. Use for questions like 'what did I spend at Loblaws' or 'show my dining expenses this month'.",
  inputSchema: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Earliest purchase date, inclusive"),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Latest purchase date, inclusive"),
    category: z.enum(RECEIPT_CATEGORIES).optional(),
    merchant: z.string().max(200).optional().describe("Case-insensitive substring match"),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async execute({ from, to, category, merchant, limit }) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };

    if (from) add("purchased_at >= ?", from);
    if (to) add("purchased_at <= ?", to);
    if (category) add("category = ?", category);
    if (merchant) add("merchant ILIKE ?", `%${merchant}%`);

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);

    const receipts = await db().query(
      `SELECT ${RECEIPT_PROJECTION} FROM receipts ${whereSql}
       ORDER BY purchased_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const totals = await db().query(
      `SELECT count(*)::int AS count, coalesce(round(sum(total_cents) / 100.0, 2), 0)::float8 AS total
       FROM receipts ${whereSql}`,
      params.slice(0, -1),
    );

    return { receipts, matched: totals[0].count, total: totals[0].total };
  },
});
