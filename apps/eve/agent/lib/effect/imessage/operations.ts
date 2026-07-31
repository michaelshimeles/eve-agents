import { createHash } from "node:crypto";

import { Effect } from "effect";

import { type DatabaseError, Db } from "../db";

function positiveEnv(name: string): number | null {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

const MESSAGE_CAPACITY = () => positiveEnv("SPECTRUM_LINE_DAILY_MESSAGE_CAPACITY");
const NEW_CONVERSATION_CAPACITY = () =>
  positiveEnv("SPECTRUM_LINE_DAILY_NEW_CONVERSATION_CAPACITY");

const ensureLineColumns = Effect.gen(function* () {
  const database = yield* Db;
  yield* database.query(
    `CREATE TABLE IF NOT EXISTS imessage_line_state (
       phone text PRIMARY KEY,
       allocation_state text NOT NULL DEFAULT 'active',
       line_capacity integer,
       daily_message_count integer NOT NULL DEFAULT 0,
       daily_new_conversation_count integer NOT NULL DEFAULT 0,
       event_health text NOT NULL DEFAULT 'unknown',
       feature_eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  yield* database.query(
    `ALTER TABLE imessage_line_state
       ADD COLUMN IF NOT EXISTS daily_new_conversation_capacity integer`,
  );
  yield* database.query(
    `ALTER TABLE imessage_line_state
       ADD COLUMN IF NOT EXISTS counter_date date NOT NULL DEFAULT current_date`,
  );
});

export function recordIMessageLineSend(input: {
  readonly phone: string;
  readonly newConversation: boolean;
}): Effect.Effect<void, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLineColumns;
    yield* database.query(
      `INSERT INTO imessage_line_state
         (phone, line_capacity, daily_new_conversation_capacity,
          daily_message_count, daily_new_conversation_count, counter_date)
       VALUES ($1, $2, $3, 1, $4, current_date)
       ON CONFLICT (phone) DO UPDATE
         SET daily_message_count =
               CASE WHEN imessage_line_state.counter_date = current_date
                 THEN imessage_line_state.daily_message_count + 1 ELSE 1 END,
             daily_new_conversation_count =
               CASE WHEN imessage_line_state.counter_date = current_date
                 THEN imessage_line_state.daily_new_conversation_count + $4 ELSE $4 END,
             line_capacity = coalesce(EXCLUDED.line_capacity, imessage_line_state.line_capacity),
             daily_new_conversation_capacity = coalesce(
               EXCLUDED.daily_new_conversation_capacity,
               imessage_line_state.daily_new_conversation_capacity
             ),
             counter_date = current_date,
             allocation_state =
               CASE
                 WHEN coalesce(EXCLUDED.line_capacity, imessage_line_state.line_capacity) IS NOT NULL
                  AND (
                    CASE WHEN imessage_line_state.counter_date = current_date
                      THEN imessage_line_state.daily_message_count + 1 ELSE 1 END
                  ) >= coalesce(EXCLUDED.line_capacity, imessage_line_state.line_capacity) * 0.7
                 THEN 'hold-new-conversations'
                 ELSE 'active'
               END,
             updated_at = now()`,
      [
        input.phone,
        MESSAGE_CAPACITY(),
        NEW_CONVERSATION_CAPACITY(),
        input.newConversation ? 1 : 0,
      ],
    );
  });
}

export function iMessageLineAcceptsNewConversation(
  phone: string,
): Effect.Effect<boolean, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLineColumns;
    const rows = yield* database.query(
      `SELECT daily_message_count, daily_new_conversation_count,
              line_capacity, daily_new_conversation_capacity,
              counter_date = current_date AS current
         FROM imessage_line_state WHERE phone = $1`,
      [phone],
    );
    const row = rows[0];
    if (row === undefined || row.current !== true) return true;
    const messages = Number(row.daily_message_count ?? 0);
    const conversations = Number(row.daily_new_conversation_count ?? 0);
    const messageCapacity = Number(row.line_capacity ?? 0);
    const conversationCapacity = Number(row.daily_new_conversation_capacity ?? 0);
    return !(
      (messageCapacity > 0 && messages / messageCapacity >= 0.7) ||
      (conversationCapacity > 0 && conversations / conversationCapacity >= 0.7)
    );
  });
}

export function iMessageOperationalOverview(): Effect.Effect<
  {
    readonly lines: readonly {
      readonly phoneRef: string;
      readonly allocationState: string;
      readonly dailyMessages: number;
      readonly dailyNewConversations: number;
      readonly messageCapacity: number | null;
      readonly newConversationCapacity: number | null;
      readonly utilization: number | null;
      readonly alert: boolean;
    }[];
    readonly media: { readonly pending: number; readonly failed: number };
    readonly interactions: { readonly pending: number; readonly completed: number };
    readonly boundConversations: number;
    readonly securityEvents: readonly {
      readonly action: string;
      readonly role: string;
      readonly target: string;
      readonly decision: string;
      readonly at: string;
    }[];
  },
  DatabaseError,
  Db
> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensureLineColumns;
    const [lines, media, interactions, conversations, security] = yield* Effect.all([
      database.query(
        `SELECT phone, allocation_state, daily_message_count,
                daily_new_conversation_count, line_capacity,
                daily_new_conversation_capacity
           FROM imessage_line_state ORDER BY updated_at DESC`,
      ),
      database.query(
        `SELECT count(*) FILTER (WHERE processing_state NOT IN ('complete', 'failed'))::float8 AS pending,
                count(*) FILTER (WHERE processing_state = 'failed')::float8 AS failed
           FROM imessage_media_temp WHERE expires_at > now()`,
      ),
      database.query(
        `SELECT count(*) FILTER (
                  WHERE status IN ('pending', 'selected') AND expires_at > now()
                )::float8 AS pending,
                count(*) FILTER (WHERE status = 'completed')::float8 AS completed
           FROM imessage_interaction`,
      ),
      database.query(
        `SELECT count(DISTINCT conversation_key)::float8 AS count
           FROM imessage_message_ref`,
      ),
      database.query(
        `SELECT action_category, actor_role, target_type, decision,
                created_at::text AS created_at
           FROM imessage_security_audit
          ORDER BY created_at DESC LIMIT 20`,
      ),
    ]);
    return {
      lines: lines.map((row) => {
        const messageCapacity =
          Number(row.line_capacity) > 0 ? Number(row.line_capacity) : null;
        const conversationCapacity =
          Number(row.daily_new_conversation_capacity) > 0
            ? Number(row.daily_new_conversation_capacity)
            : null;
        const dailyMessages = Number(row.daily_message_count ?? 0);
        const dailyNewConversations = Number(row.daily_new_conversation_count ?? 0);
        const utilization = Math.max(
          messageCapacity === null ? 0 : dailyMessages / messageCapacity,
          conversationCapacity === null
            ? 0
            : dailyNewConversations / conversationCapacity,
        );
        return {
          phoneRef: createHash("sha256")
            .update(String(row.phone ?? ""))
            .digest("hex")
            .slice(0, 12),
          allocationState: String(row.allocation_state ?? "unknown"),
          dailyMessages,
          dailyNewConversations,
          messageCapacity,
          newConversationCapacity: conversationCapacity,
          utilization:
            messageCapacity === null && conversationCapacity === null
              ? null
              : utilization,
          alert: utilization >= 0.8,
        };
      }),
      media: {
        pending: Number(media[0]?.pending ?? 0),
        failed: Number(media[0]?.failed ?? 0),
      },
      interactions: {
        pending: Number(interactions[0]?.pending ?? 0),
        completed: Number(interactions[0]?.completed ?? 0),
      },
      boundConversations: Number(conversations[0]?.count ?? 0),
      securityEvents: security.map((row) => ({
        action: String(row.action_category ?? ""),
        role: String(row.actor_role ?? ""),
        target: String(row.target_type ?? ""),
        decision: String(row.decision ?? ""),
        at: String(row.created_at ?? ""),
      })),
    };
  });
}
