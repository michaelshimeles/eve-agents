import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DatabaseError, Db, type DbRow } from "./db";
import { IMessagePairing, IMessagePairingLive } from "./imessage";

const pairingRow: DbRow = {
  router_url: "https://router.example",
  handle: "+15551234567",
  status: "verified",
  pairing_id: null,
  secret: "pairing-secret",
  requested_at: "2026-07-30T12:00:00.000Z",
  verified_at: "2026-07-30T12:01:00.000Z",
};

function pairingLayer(
  answer: (sql: string, params: unknown[]) => DbRow[] | DatabaseError,
): {
  layer: Layer.Layer<IMessagePairing>;
  queries: { sql: string; params: unknown[] }[];
} {
  const queries: { sql: string; params: unknown[] }[] = [];
  const query = (sql: string, params: unknown[] = []) =>
    Effect.suspend(() => {
      queries.push({ sql, params });
      const result = answer(sql, params);
      return result instanceof DatabaseError
        ? Effect.fail(result)
        : Effect.succeed(result);
    });
  const db = Layer.succeed(Db, {
    query,
    transaction: (statements) =>
      Effect.forEach(statements, (statement) =>
        query(statement.sql, statement.params),
      ),
  });
  return {
    layer: IMessagePairingLive.pipe(Layer.provide(db)),
    queries,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("iMessage transcript", () => {
  it("records an inbound provider message once it is claimed", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    const { layer, queries } = pairingLayer((sql) =>
      sql.includes("INSERT INTO imessage_inbound")
        ? [{ message_id: "msg_1" }]
        : [],
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* IMessagePairing;
        return yield* service.claimInbound({
          messageId: "msg_1",
          spaceId: "space_1",
          ownerHandle: "+15551234567",
          handle: "+15551234567",
          text: "Can you check this?",
          attachments: [{ name: "photo.heic", mimeType: "image/heic" }],
          chatType: "dm",
          role: "owner",
          phone: "+15550001111",
          receivedAtMs: Date.parse("2026-07-30T12:02:00.000Z"),
          routeReceivedAtMs: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("new");
    const insert = queries.find(({ sql }) =>
      sql.includes("INSERT INTO imessage_transcript"),
    );
    expect(insert?.params).toEqual([
      "inbound:msg_1",
      "mixed",
      "+15551234567",
      "owner",
      "dm",
      "space_1",
      "+15550001111",
      "msg_1",
      "Can you check this?",
      JSON.stringify([{ name: "photo.heic", mimeType: "image/heic" }]),
      Date.parse("2026-07-30T12:02:00.000Z"),
    ]);
  });

  it("does not block an inbound message when the transcript write fails", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { layer } = pairingLayer((sql) => {
      if (sql.includes("INSERT INTO imessage_inbound"))
        return [{ message_id: "msg_2" }];
      if (sql.includes("INSERT INTO imessage_transcript")) {
        return new DatabaseError({
          cause: new Error("transcript unavailable"),
        });
      }
      return [];
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* IMessagePairing;
        return yield* service.claimInbound({
          messageId: "msg_2",
          spaceId: "space_2",
          ownerHandle: "+15551234567",
          handle: "+15551234567",
          text: "This still needs a reply.",
          attachments: [],
          chatType: "dm",
          role: "owner",
          receivedAtMs: Date.parse("2026-07-30T12:02:00.000Z"),
          routeReceivedAtMs: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("new");
    expect(warning).toHaveBeenCalledWith(
      "iMessage transcript inbound receive failed.",
      expect.stringContaining("transcript unavailable"),
    );
  });

  it("moves an outbound entry from sending to sent around the router call", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );
    const { layer, queries } = pairingLayer((sql) =>
      sql.includes("FROM imessage_pairing WHERE id = 1") ? [pairingRow] : [],
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* IMessagePairing;
        yield* service.sendReply({
          handle: "+15551234567",
          text: "All clear.",
          space: "group_1",
        });
      }).pipe(Effect.provide(layer)),
    );

    const writes = queries.filter(({ sql }) =>
      sql.includes("INSERT INTO imessage_transcript"),
    );
    expect(writes).toHaveLength(2);
    expect(writes.map(({ params }) => params[8])).toEqual(["sending", "sent"]);
    expect(writes[0]?.params.slice(1, 8)).toEqual([
      "text",
      "+15551234567",
      "group",
      "group_1",
      null,
      "All clear.",
      "[]",
    ]);
    expect(writes[0]?.params[0]).toBe(writes[1]?.params[0]);
  });

  it("returns newest transcript rows and caps the requested limit", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    const { layer, queries } = pairingLayer((sql) =>
      sql.includes("FROM imessage_transcript")
        ? [
            {
              entry_id: "outbound:1",
              direction: "outbound",
              kind: "text",
              handle: "+15551234567",
              role: "assistant",
              chat_type: "dm",
              space_id: null,
              phone: null,
              message_id: null,
              text: "Done.",
              attachments: [],
              status: "sent",
              error: null,
              session_id: null,
              occurred_at: "2026-07-30T12:03:00.000Z",
              updated_at: "2026-07-30T12:03:01.000Z",
            },
          ]
        : [],
    );

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* IMessagePairing;
        return yield* service.listTranscript(999);
      }).pipe(Effect.provide(layer)),
    );

    expect(entries).toEqual([
      expect.objectContaining({
        id: "outbound:1",
        direction: "outbound",
        text: "Done.",
        status: "sent",
      }),
    ]);
    const select = queries.find(({ sql }) =>
      sql.includes("FROM imessage_transcript"),
    );
    expect(select?.params).toEqual([200]);
  });
});
