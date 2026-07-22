import { defineTool } from "eve/tools";
import { z } from "zod";
import { RECEIPT_CATEGORIES, RECEIPT_PROJECTION, db } from "../lib/receipts-db";

export default defineTool({
  description:
    "Log a purchase receipt to the expense database. Use when the user sends a receipt photo (extract the fields from the image) or describes a purchase to log. Amounts are in dollars.",
  inputSchema: z.object({
    merchant: z.string().min(1).max(200).describe("Store or vendor name as printed"),
    total: z.number().positive().describe("Grand total in dollars, e.g. 84.20"),
    currency: z
      .string()
      .length(3)
      .toUpperCase()
      .default("CAD")
      .describe("ISO currency code from the receipt, default CAD"),
    category: z.enum(RECEIPT_CATEGORIES).describe("Best-fit spending category"),
    purchased_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("Purchase date YYYY-MM-DD; use today if the receipt shows none"),
    items: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          price: z.number().optional().describe("Line price in dollars"),
          quantity: z.number().optional(),
        }),
      )
      .max(100)
      .optional()
      .describe("Line items when legible"),
    notes: z.string().max(1000).optional().describe("Anything worth remembering about this purchase"),
  }),
  async execute(input) {
    const rows = await db().query(
      `INSERT INTO receipts (merchant, total_cents, currency, category, purchased_at, items, notes)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING ${RECEIPT_PROJECTION}`,
      [
        input.merchant,
        Math.round(input.total * 100),
        input.currency,
        input.category,
        input.purchased_at,
        input.items ? JSON.stringify(input.items) : null,
        input.notes ?? null,
      ],
    );
    return rows[0];
  },
});
