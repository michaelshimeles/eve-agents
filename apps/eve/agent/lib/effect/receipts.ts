import { Context, Effect, Layer, Schema } from "effect";
import type { SchemaError } from "effect/SchemaError";

import { type DatabaseError, Db } from "./db";

// Receipt tracking as an Effect service. Schema is the single source of
// truth: the same structs type the service, validate model tool input (via
// agent/lib/effect/tool-schema.ts), and decode rows coming back from Neon.
// Money is stored as integer cents; tools speak in dollars.

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

export const ReceiptCategory = Schema.Literals(RECEIPT_CATEGORIES);
export type ReceiptCategory = typeof ReceiptCategory.Type;

/** Calendar date as YYYY-MM-DD (receipts store no time of day). */
const DateOnly = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

/** One receipt as tools return it: dates as text, money in dollars. */
export const Receipt = Schema.Struct({
  id: Schema.Int,
  merchant: Schema.String,
  total: Schema.Finite,
  currency: Schema.String,
  category: Schema.String,
  purchased_at: Schema.String,
  notes: Schema.NullOr(Schema.String),
});
export type Receipt = typeof Receipt.Type;

export const LogReceiptInput = Schema.Struct({
  merchant: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Store or vendor name as printed",
  }),
  total: Schema.Finite.check(Schema.isGreaterThan(0)).annotate({
    description: "Grand total in dollars, e.g. 84.20",
  }),
  currency: Schema.String.check(Schema.isPattern(/^[A-Za-z]{3}$/))
    .annotate({ description: "ISO currency code from the receipt, default CAD" })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed("CAD"))),
  category: ReceiptCategory.annotate({ description: "Best-fit spending category" }),
  purchased_at: DateOnly.annotate({
    description: "Purchase date YYYY-MM-DD; use today if the receipt shows none",
  }),
  items: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      price: Schema.optionalKey(
        Schema.Finite.annotate({ description: "Line price in dollars" }),
      ),
      quantity: Schema.optionalKey(Schema.Finite),
    }),
  )
    .check(Schema.isMaxLength(100))
    .annotate({ description: "Line items when legible" })
    .pipe(Schema.optionalKey),
  notes: Schema.String.check(Schema.isMaxLength(1000))
    .annotate({ description: "Anything worth remembering about this purchase" })
    .pipe(Schema.optionalKey),
});
export type LogReceiptInput = typeof LogReceiptInput.Type;

export const QueryReceiptsInput = Schema.Struct({
  from: Schema.optionalKey(DateOnly.annotate({ description: "Earliest purchase date, inclusive" })),
  to: Schema.optionalKey(DateOnly.annotate({ description: "Latest purchase date, inclusive" })),
  category: Schema.optionalKey(ReceiptCategory),
  merchant: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "Case-insensitive substring match",
    }),
  ),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(50)),
  ),
});
export type QueryReceiptsInput = typeof QueryReceiptsInput.Type;

export const SpendingSummaryInput = Schema.Struct({
  from: Schema.optionalKey(DateOnly.annotate({ description: "Earliest purchase date, inclusive" })),
  to: Schema.optionalKey(DateOnly.annotate({ description: "Latest purchase date, inclusive" })),
  group_by: Schema.Literals(["category", "merchant", "month"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("category" as const)),
  ),
});
export type SpendingSummaryInput = typeof SpendingSummaryInput.Type;

const ReceiptSearchResult = Schema.Struct({
  receipts: Schema.Array(Receipt),
  matched: Schema.Int,
  total: Schema.Finite,
});
export type ReceiptSearchResult = typeof ReceiptSearchResult.Type;

const SpendingSummary = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({ group: Schema.String, total: Schema.Finite, receipts: Schema.Int }),
  ),
  overall: Schema.Struct({ total: Schema.Finite, receipts: Schema.Int }),
});
export type SpendingSummary = typeof SpendingSummary.Type;

// Shared SELECT projection: JSON-serializable values only (dates as text,
// cents converted to dollars).
const PROJECTION = `
  id,
  merchant,
  round(total_cents / 100.0, 2)::float8 AS total,
  currency,
  category,
  purchased_at::text AS purchased_at,
  notes
`;

export type ReceiptsError = DatabaseError | SchemaError;

export class Receipts extends Context.Service<Receipts, {
  readonly log: (input: LogReceiptInput) => Effect.Effect<Receipt, ReceiptsError>;
  readonly search: (input: QueryReceiptsInput) => Effect.Effect<ReceiptSearchResult, ReceiptsError>;
  readonly summarize: (input: SpendingSummaryInput) => Effect.Effect<SpendingSummary, ReceiptsError>;
  readonly remove: (id: number) => Effect.Effect<{ deleted: boolean }, DatabaseError>;
}>()("Receipts") {}

/** Builds `WHERE purchased_at >= $n AND purchased_at <= $m` for date ranges. */
function dateRange(from: string | undefined, to: string | undefined) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (from !== undefined) {
    params.push(from);
    where.push(`purchased_at >= $${params.length}`);
  }
  if (to !== undefined) {
    params.push(to);
    where.push(`purchased_at <= $${params.length}`);
  }
  return { where, params };
}

export const ReceiptsLive = Layer.effect(
  Receipts,
  Effect.gen(function* () {
    const database = yield* Db;

    const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(Receipt));
    const decodeSearchTotals = Schema.decodeUnknownEffect(
      Schema.Struct({ count: Schema.Int, total: Schema.Finite }),
    );
    const decodeSummaryGroups = Schema.decodeUnknownEffect(SpendingSummary.fields.groups);
    const decodeSummaryOverall = Schema.decodeUnknownEffect(SpendingSummary.fields.overall);

    return {
      log: (input) =>
        Effect.gen(function* () {
          const rows = yield* database.query(
            `INSERT INTO receipts (merchant, total_cents, currency, category, purchased_at, items, notes)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
             RETURNING ${PROJECTION}`,
            [
              input.merchant,
              Math.round(input.total * 100),
              input.currency.toUpperCase(),
              input.category,
              input.purchased_at,
              input.items !== undefined ? JSON.stringify(input.items) : null,
              input.notes ?? null,
            ],
          );
          return (yield* decodeReceipts(rows))[0];
        }),

      search: (input) =>
        Effect.gen(function* () {
          const { where, params } = dateRange(input.from, input.to);
          if (input.category !== undefined) {
            params.push(input.category);
            where.push(`category = $${params.length}`);
          }
          if (input.merchant !== undefined) {
            params.push(`%${input.merchant}%`);
            where.push(`merchant ILIKE $${params.length}`);
          }
          const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

          const receiptRows = yield* database.query(
            `SELECT ${PROJECTION} FROM receipts ${whereSql}
             ORDER BY purchased_at DESC, id DESC LIMIT $${params.length + 1}`,
            [...params, input.limit],
          );
          const totalRows = yield* database.query(
            `SELECT count(*)::int AS count, coalesce(round(sum(total_cents) / 100.0, 2), 0)::float8 AS total
             FROM receipts ${whereSql}`,
            params,
          );

          const receipts = yield* decodeReceipts(receiptRows);
          const totals = yield* decodeSearchTotals(totalRows[0]);
          return { receipts, matched: totals.count, total: totals.total };
        }),

      summarize: (input) =>
        Effect.gen(function* () {
          const groupings = {
            category: "category",
            merchant: "merchant",
            month: "to_char(purchased_at, 'YYYY-MM')",
          } as const;
          const { where, params } = dateRange(input.from, input.to);
          const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

          const groupRows = yield* database.query(
            `SELECT ${groupings[input.group_by]} AS "group",
                    round(sum(total_cents) / 100.0, 2)::float8 AS total,
                    count(*)::int AS receipts
             FROM receipts ${whereSql}
             GROUP BY 1 ORDER BY 2 DESC`,
            params,
          );
          const overallRows = yield* database.query(
            `SELECT coalesce(round(sum(total_cents) / 100.0, 2), 0)::float8 AS total, count(*)::int AS receipts
             FROM receipts ${whereSql}`,
            params,
          );

          const groups = yield* decodeSummaryGroups(groupRows);
          const overall = yield* decodeSummaryOverall(overallRows[0]);
          return { groups, overall };
        }),

      remove: (id) =>
        Effect.gen(function* () {
          const rows = yield* database.query(
            "DELETE FROM receipts WHERE id = $1 RETURNING id",
            [id],
          );
          return { deleted: rows.length > 0 };
        }),
    };
  }),
);

// Accessors: build programs against the service without resolving it, so
// call sites stay one-liners and tests can swap the layer.

export const logReceipt = (
  input: LogReceiptInput,
): Effect.Effect<Receipt, ReceiptsError, Receipts> =>
  Effect.gen(function* () {
    return yield* (yield* Receipts).log(input);
  });

export const queryReceipts = (
  input: QueryReceiptsInput,
): Effect.Effect<ReceiptSearchResult, ReceiptsError, Receipts> =>
  Effect.gen(function* () {
    return yield* (yield* Receipts).search(input);
  });

export const spendingSummary = (
  input: SpendingSummaryInput,
): Effect.Effect<SpendingSummary, ReceiptsError, Receipts> =>
  Effect.gen(function* () {
    return yield* (yield* Receipts).summarize(input);
  });

export const deleteReceipt = (
  id: number,
): Effect.Effect<{ deleted: boolean }, DatabaseError, Receipts> =>
  Effect.gen(function* () {
    return yield* (yield* Receipts).remove(id);
  });
