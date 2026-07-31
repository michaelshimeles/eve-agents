import { createHash } from "node:crypto";

import { Effect } from "effect";

import { type DatabaseError, Db } from "../db";
import { encryptProviderIdentifier } from "./store";

function hash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

const ensurePollTables = Effect.gen(function* () {
  const database = yield* Db;
  yield* database.query(
    `CREATE TABLE IF NOT EXISTS imessage_poll_binding (
       provider_message_hash text PRIMARY KEY,
       encrypted_provider_message text NOT NULL,
       interaction_id uuid NOT NULL REFERENCES imessage_interaction(interaction_id) ON DELETE CASCADE,
       conversation_key text NOT NULL,
       owner_hash text NOT NULL,
       option_map jsonb NOT NULL,
       expires_at timestamptz NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  yield* database.query(
    `CREATE TABLE IF NOT EXISTS imessage_poll_vote (
       provider_message_hash text NOT NULL,
       participant_hash text NOT NULL,
       option_id text NOT NULL,
       owner_vote boolean NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (provider_message_hash, participant_hash)
     )`,
  );
});

export function cleanupIMessagePollRetention(): Effect.Effect<
  void,
  DatabaseError,
  Db
> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensurePollTables;
    yield* database.query(
      `DELETE FROM imessage_poll_vote
        WHERE provider_message_hash IN (
          SELECT provider_message_hash
            FROM imessage_poll_binding
           WHERE expires_at <= now()
        )`,
    );
    yield* database.query(
      `DELETE FROM imessage_poll_binding WHERE expires_at <= now()`,
    );
  });
}

export function registerIMessagePollBinding(input: {
  readonly providerMessageId: string;
  readonly interactionId: string;
  readonly conversationKey: string;
  readonly ownerHandle: string;
  readonly options: readonly {
    readonly providerOptionId: string;
    readonly ruthOptionId: string;
  }[];
  readonly expiresAt: string;
}): Effect.Effect<void, DatabaseError, Db> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensurePollTables;
    yield* database.query(
      `INSERT INTO imessage_poll_binding
         (provider_message_hash, encrypted_provider_message, interaction_id,
          conversation_key, owner_hash, option_map, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
       ON CONFLICT (provider_message_hash) DO NOTHING`,
      [
        hash(input.providerMessageId),
        encryptProviderIdentifier(input.providerMessageId),
        input.interactionId,
        input.conversationKey,
        hash(input.ownerHandle),
        JSON.stringify(Object.fromEntries(
          input.options.map((option) => [
            option.providerOptionId,
            option.ruthOptionId,
          ]),
        )),
        input.expiresAt,
      ],
    );
  });
}

export function recordIMessagePollVote(input: {
  readonly providerMessageId: string;
  readonly participant: string;
  readonly providerOptionId: string;
}): Effect.Effect<
  | { readonly kind: "unbound" | "guest" | "duplicate" }
  | {
      readonly kind: "owner";
      readonly interactionId: string;
    },
  DatabaseError,
  Db
> {
  return Effect.gen(function* () {
    const database = yield* Db;
    yield* ensurePollTables;
    const providerHash = hash(input.providerMessageId);
    const rows = yield* database.query(
      `SELECT interaction_id::text AS interaction_id, owner_hash, option_map
         FROM imessage_poll_binding
        WHERE provider_message_hash = $1 AND expires_at > now()`,
      [providerHash],
    );
    const binding = rows[0];
    if (binding === undefined) return { kind: "unbound" as const };
    const owner = binding.owner_hash === hash(input.participant);
    yield* database.query(
      `INSERT INTO imessage_poll_vote
         (provider_message_hash, participant_hash, option_id, owner_vote)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider_message_hash, participant_hash) DO UPDATE
         SET option_id = EXCLUDED.option_id,
             owner_vote = EXCLUDED.owner_vote,
             updated_at = now()`,
      [providerHash, hash(input.participant), input.providerOptionId, owner],
    );
    if (!owner) return { kind: "guest" as const };
    const optionMap =
      binding.option_map !== null &&
      typeof binding.option_map === "object" &&
      !Array.isArray(binding.option_map)
        ? (binding.option_map as Record<string, unknown>)
        : {};
    const optionId = optionMap[input.providerOptionId];
    if (typeof optionId !== "string") return { kind: "unbound" as const };
    const selected = yield* database.query(
      `UPDATE imessage_interaction
          SET status = 'selected',
              result = jsonb_build_object('optionId', $2::text),
              used_at = now(),
              updated_at = now()
        WHERE interaction_id = $1 AND status = 'pending' AND expires_at > now()
        RETURNING interaction_id::text AS interaction_id`,
      [String(binding.interaction_id), optionId],
    );
    const interactionId = selected[0]?.interaction_id;
    if (typeof interactionId === "string") {
      return { kind: "owner" as const, interactionId };
    }
    const current = yield* database.query(
      `SELECT status
         FROM imessage_interaction
        WHERE interaction_id = $1 AND expires_at > now()`,
      [String(binding.interaction_id)],
    );
    if (current[0]?.status !== "selected") {
      return { kind: "duplicate" as const };
    }
    return {
      kind: "owner" as const,
      interactionId: String(binding.interaction_id),
    };
  });
}
