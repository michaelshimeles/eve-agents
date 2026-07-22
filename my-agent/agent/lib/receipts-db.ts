import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Lazy init: eve evaluates authored modules at build time, where DATABASE_URL
// may be absent. Schema lives in the receipts table (see repo history):
// id, merchant, total_cents, currency, category, purchased_at, items, notes,
// logged_at. Money is stored as integer cents; tools speak in dollars.
let _sql: NeonQueryFunction<false, false> | null = null;

export function db(): NeonQueryFunction<false, false> {
  if (_sql === null) _sql = neon(process.env.DATABASE_URL!);
  return _sql;
}

export const RECEIPT_CATEGORIES = [
  "groceries",
  "dining",
  "transport",
  "shopping",
  "health",
  "entertainment",
  "utilities",
  "travel",
  "subscriptions",
  "other",
] as const;

export type ReceiptCategory = (typeof RECEIPT_CATEGORIES)[number];

export interface ReceiptRow {
  id: number;
  merchant: string;
  total: number;
  currency: string;
  category: string;
  purchased_at: string;
  notes: string | null;
}

// Shared SELECT projection: JSON-serializable values only (dates as text,
// cents converted to dollars).
export const RECEIPT_PROJECTION = `
  id,
  merchant,
  round(total_cents / 100.0, 2)::float8 AS total,
  currency,
  category,
  purchased_at::text AS purchased_at,
  notes
`;
