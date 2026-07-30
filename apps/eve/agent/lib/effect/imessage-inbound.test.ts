import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Db, type DbRow } from "./db";
import {
  IMessagePairingLive,
  claimIMessageInbound,
  discardIMessageInboundForReset,
  isIMessageInboundBatchCurrent,
  recordIMessageInboundBatch,
  releaseIMessageDeliveryLock,
  releaseIMessageInboundBatch,
  settleIMessageInbound,
  tryAcquireIMessageDeliveryLock,
} from "./imessage";

interface InboundRow {
  messageId: string;
  spaceId: string;
  handle: string;
  text: string | null;
  status: string;
  receivedAtMs: number;
  routeReceivedAtMs: number;
  sequence: number;
}

/**
 * Focused imitation of the imessage_inbound statements used by the pairing
 * layer. The test deliberately drives the public Effects, including their SQL
 * state transitions, instead of duplicating the channel's reset decision.
 */
function inboundRuntime() {
  const rows = new Map<string, InboundRow>();
  const resetBarriers = new Map<
    string,
    { receivedAtMs: number; routeReceivedAtMs: number }
  >();
  const deliveryLocks = new Map<string, string>();
  let sequence = 0;
  const conversationKey = (handle: string, spaceId: string) => `${handle}\u001f${spaceId}`;

  const query = (sql: string, params: unknown[] = []): Effect.Effect<DbRow[]> =>
    Effect.sync(() => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS") ||
        sql.includes("ALTER TABLE imessage_inbound") ||
        sql.includes("ALTER TABLE imessage_reset_barrier") ||
        sql.includes("SET received_at = claimed_at") ||
        sql.includes("WHERE route_received_at IS NULL") ||
        sql.includes("WHERE reset_route_received_at IS NULL") ||
        sql.includes("imessage_transcript") ||
        sql.includes("pg_advisory_xact_lock")
      ) {
        return [];
      }

      if (sql.includes("INSERT INTO imessage_inbound")) {
        const [
          messageId,
          spaceId,
          handle,
          text,
          receivedAtMs,
          ownerHandle,
          routeReceivedAtMs,
        ] = params as [
          string,
          string,
          string,
          string | null,
          number,
          string,
          number,
        ];
        const reset = resetBarriers.get(conversationKey(ownerHandle, spaceId));
        if (
          reset !== undefined &&
          (reset.receivedAtMs > receivedAtMs ||
            (reset.receivedAtMs === receivedAtMs &&
              reset.routeReceivedAtMs >= routeReceivedAtMs))
        ) {
          return [];
        }
        if (rows.has(messageId)) return [];
        sequence += 1;
        rows.set(messageId, {
          messageId,
          spaceId,
          handle,
          text,
          status: "claimed",
          receivedAtMs,
          routeReceivedAtMs,
          sequence,
        });
        return [{ message_id: messageId }];
      }

      if (sql.includes("INSERT INTO imessage_delivery_lock")) {
        const [ownerHandle, spaceId, token] = params as [string, string, string];
        const key = conversationKey(ownerHandle, spaceId);
        if (deliveryLocks.has(key)) return [];
        deliveryLocks.set(key, token);
        return [{ token }];
      }

      if (sql.includes("DELETE FROM imessage_delivery_lock")) {
        const [ownerHandle, spaceId, token] = params as [string, string, string];
        const key = conversationKey(ownerHandle, spaceId);
        if (deliveryLocks.get(key) === token) deliveryLocks.delete(key);
        return [];
      }

      if (sql.includes("SELECT status FROM imessage_inbound")) {
        const row = rows.get(params[0] as string);
        return row === undefined ? [] : [{ status: row.status }];
      }

      if (sql.includes("INSERT INTO imessage_reset_barrier")) {
        const [ownerHandle, spaceId, resetAtMs, resetRouteReceivedAtMs] = params as [
          string,
          string,
          number,
          number,
        ];
        const key = conversationKey(ownerHandle, spaceId);
        const current = resetBarriers.get(key);
        if (
          current === undefined ||
          resetAtMs > current.receivedAtMs ||
          (resetAtMs === current.receivedAtMs &&
            resetRouteReceivedAtMs > current.routeReceivedAtMs)
        ) {
          resetBarriers.set(key, {
            receivedAtMs: resetAtMs,
            routeReceivedAtMs: resetRouteReceivedAtMs,
          });
        }
        return [];
      }

      if (sql.includes("SET status = 'reset'")) {
        const [ownerHandle, spaceId, resetMessageId] = params as [string, string, string];
        const reset = resetBarriers.get(conversationKey(ownerHandle, spaceId));
        for (const row of rows.values()) {
          if (
            row.spaceId === spaceId &&
            row.messageId !== resetMessageId &&
            reset !== undefined &&
            (row.receivedAtMs < reset.receivedAtMs ||
              (row.receivedAtMs === reset.receivedAtMs &&
                row.routeReceivedAtMs <= reset.routeReceivedAtMs)) &&
            (row.status === "claimed" ||
              row.status === "dispatching" ||
              row.status === "ok" ||
              row.status === "error")
          ) {
            row.status = "reset";
          }
        }
        return [];
      }

      if (sql.includes("status <> 'reset'") && sql.includes("ANY($1::text[])")) {
        const ids = params[0] as string[];
        return ids
          .map((id) => rows.get(id))
          .filter((row): row is InboundRow => row !== undefined && row.status !== "reset")
          .map((row) => ({ message_id: row.messageId }));
      }

      if (sql.includes("SELECT message_id FROM imessage_inbound")) {
        const [handle, spaceId] = params as [string, string];
        const newest = [...rows.values()]
          .filter(
            (row) =>
              row.handle === handle && row.spaceId === spaceId && row.status === "claimed",
          )
          .sort((left, right) => right.sequence - left.sequence)[0];
        return newest === undefined ? [] : [{ message_id: newest.messageId }];
      }

      if (sql.includes("WITH drained AS")) {
        const [handle, spaceId] = params as [string, string];
        return [...rows.values()]
          .filter(
            (row) =>
              row.handle === handle && row.spaceId === spaceId && row.status === "claimed",
          )
          .sort((left, right) => left.sequence - right.sequence)
          .map((row) => {
            row.status = "dispatching";
            return {
              message_id: row.messageId,
              text: row.text,
              claimed_at: row.sequence,
            };
          });
      }

      if (sql.includes("SET status = $2")) {
        const [ids, status] = params as [string[], string];
        for (const id of ids) {
          const row = rows.get(id);
          if (
            row !== undefined &&
            (row.status === "claimed" || row.status === "dispatching")
          ) {
            row.status = status;
          }
        }
        return [];
      }

      if (sql.includes("SET status = 'claimed'")) {
        const [ids, ownMessageId] = params as [string[], string];
        for (const id of ids) {
          const row = rows.get(id);
          if (
            id !== ownMessageId &&
            row !== undefined &&
            row.status === "dispatching"
          ) {
            row.status = "claimed";
          }
        }
        return [];
      }

      if (sql.includes("DELETE FROM imessage_inbound")) {
        const id = params[0] as string;
        if (rows.get(id)?.status === "dispatching") rows.delete(id);
        return [];
      }

      throw new Error(`unexpected SQL in iMessage inbound test: ${sql}`);
    });

  const DbMemory = Layer.sync(Db, () => ({
    query,
    transaction: (statements) =>
      Effect.forEach(statements, (statement) => query(statement.sql, statement.params)),
  }));
  return ManagedRuntime.make(IMessagePairingLive.pipe(Layer.provide(DbMemory)));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("iMessage inbound reset barrier", () => {
  it("keeps a pre-/new debounce claim out of the fresh conversation", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://imessage-reset-test");
    const runtime = inboundRuntime();
    const handle = "+14165550123";
    const spaceId = "dm_1";

    expect(
      await runtime.runPromise(
        claimIMessageInbound({
          messageId: "before_reset",
          spaceId,
          ownerHandle: handle,
          handle,
          text: "old question",
          receivedAtMs: 1_000,
          routeReceivedAtMs: 10,
        }),
      ),
    ).toBe("new");
    await runtime.runPromise(
      claimIMessageInbound({
        messageId: "reset",
        spaceId,
        ownerHandle: handle,
        handle,
        text: "/new",
        receivedAtMs: 2_000,
        routeReceivedAtMs: 20,
      }),
    );

    await runtime.runPromise(
      discardIMessageInboundForReset({
        ownerHandle: handle,
        spaceId,
        resetMessageId: "reset",
        resetAtMs: 2_000,
        resetRouteReceivedAtMs: 20,
      }),
    );
    await runtime.runPromise(recordIMessageInboundBatch(["reset"], { status: "ok" }));

    expect(
      await runtime.runPromise(
        settleIMessageInbound({ handle, spaceId, messageId: "before_reset" }),
      ),
    ).toEqual({ dispatch: false });
    expect(
      await runtime.runPromise(
        isIMessageInboundBatchCurrent(["before_reset"]),
      ),
    ).toBe(false);

    // A late failing request must not revive or delete the terminal reset row.
    await runtime.runPromise(
      releaseIMessageInboundBatch({
        ownMessageId: "before_reset",
        batchMessageIds: ["before_reset"],
      }),
    );
    expect(
      await runtime.runPromise(
        claimIMessageInbound({
          messageId: "before_reset",
          spaceId,
          ownerHandle: handle,
          handle,
          text: "old question",
          receivedAtMs: 1_000,
          routeReceivedAtMs: 10,
        }),
      ),
    ).toBe("done");

    await runtime.runPromise(
      claimIMessageInbound({
        messageId: "after_reset",
        spaceId,
        ownerHandle: handle,
        handle,
        text: "new question",
        receivedAtMs: 3_000,
        routeReceivedAtMs: 30,
      }),
    );
    const fresh = await runtime.runPromise(
      settleIMessageInbound({ handle, spaceId, messageId: "after_reset" }),
    );
    expect(fresh).toEqual({
      dispatch: true,
      batch: [{ messageId: "after_reset", text: "new question" }],
    });
    expect(
      await runtime.runPromise(
        isIMessageInboundBatchCurrent(["after_reset"]),
      ),
    ).toBe(true);
    await runtime.runPromise(
      recordIMessageInboundBatch(["after_reset"], { status: "ok" }),
    );
    expect(
      await runtime.runPromise(isIMessageInboundBatchCurrent(["after_reset"])),
    ).toBe(true);
    await runtime.runPromise(
      discardIMessageInboundForReset({
        ownerHandle: handle,
        spaceId,
        resetMessageId: "later_reset",
        resetAtMs: 4_000,
        resetRouteReceivedAtMs: 40,
      }),
    );
    expect(
      await runtime.runPromise(isIMessageInboundBatchCurrent(["after_reset"])),
    ).toBe(false);
  });

  it("rejects a pre-reset delivery whose database claim arrives after /new", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://imessage-late-claim-test");
    const runtime = inboundRuntime();
    const handle = "+14165550123";
    const spaceId = "dm_1";

    await runtime.runPromise(
      claimIMessageInbound({
        messageId: "reset",
        spaceId,
        ownerHandle: handle,
        handle,
        text: "/new",
        receivedAtMs: 2_000,
        routeReceivedAtMs: 20,
      }),
    );
    await runtime.runPromise(
      discardIMessageInboundForReset({
        ownerHandle: handle,
        spaceId,
        resetMessageId: "reset",
        resetAtMs: 2_000,
        resetRouteReceivedAtMs: 20,
      }),
    );
    await runtime.runPromise(recordIMessageInboundBatch(["reset"], { status: "ok" }));

    // This request entered the route first, but was delayed before its claim.
    // The persisted cutoff still refuses it after /new has completed.
    expect(
      await runtime.runPromise(
        claimIMessageInbound({
          messageId: "late_old_delivery",
          spaceId,
          ownerHandle: handle,
          handle,
          text: "old question",
          receivedAtMs: 1_000,
          routeReceivedAtMs: 10,
        }),
      ),
    ).toBe("done");
    expect(
      await runtime.runPromise(
        settleIMessageInbound({
          handle,
          spaceId,
          messageId: "late_old_delivery",
        }),
      ),
    ).toEqual({ dispatch: false });

    expect(
      await runtime.runPromise(
        claimIMessageInbound({
          messageId: "after_reset",
          spaceId,
          ownerHandle: handle,
          handle,
          text: "new question",
          // Distinct subsequent deliveries can share Spectrum's timestamp.
          receivedAtMs: 2_000,
          routeReceivedAtMs: 30,
        }),
      ),
    ).toBe("new");
    expect(
      await runtime.runPromise(
        settleIMessageInbound({ handle, spaceId, messageId: "after_reset" }),
      ),
    ).toEqual({
      dispatch: true,
      batch: [{ messageId: "after_reset", text: "new question" }],
    });
  });

  it("applies the owner's group reset barrier to guest deliveries", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://imessage-group-reset-test");
    const runtime = inboundRuntime();
    const ownerHandle = "+14165550123";
    const guestHandle = "+14165550124";
    const spaceId = "group_1";

    await runtime.runPromise(
      claimIMessageInbound({
        messageId: "guest_before_reset",
        spaceId,
        ownerHandle,
        handle: guestHandle,
        text: "guest old question",
        receivedAtMs: 1_000,
        routeReceivedAtMs: 10,
      }),
    );
    await runtime.runPromise(
      claimIMessageInbound({
        messageId: "owner_reset",
        spaceId,
        ownerHandle,
        handle: ownerHandle,
        text: "/new",
        receivedAtMs: 2_000,
        routeReceivedAtMs: 20,
      }),
    );
    await runtime.runPromise(
      discardIMessageInboundForReset({
        ownerHandle,
        spaceId,
        resetMessageId: "owner_reset",
        resetAtMs: 2_000,
        resetRouteReceivedAtMs: 20,
      }),
    );

    expect(
      await runtime.runPromise(
        settleIMessageInbound({
          handle: guestHandle,
          spaceId,
          messageId: "guest_before_reset",
        }),
      ),
    ).toEqual({ dispatch: false });
    expect(
      await runtime.runPromise(
        claimIMessageInbound({
          messageId: "guest_late_old_delivery",
          spaceId,
          ownerHandle,
          handle: guestHandle,
          text: "guest old question",
          receivedAtMs: 1_500,
          routeReceivedAtMs: 15,
        }),
      ),
    ).toBe("done");
    expect(
      await runtime.runPromise(
        claimIMessageInbound({
          messageId: "guest_after_reset",
          spaceId,
          ownerHandle,
          handle: guestHandle,
          text: "guest new question",
          receivedAtMs: 2_000,
          routeReceivedAtMs: 30,
        }),
      ),
    ).toBe("new");
  });

  it("leases one conversation delivery boundary to one reset or reply", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://imessage-delivery-lock-test");
    const runtime = inboundRuntime();
    const ownerHandle = "+14165550123";
    const spaceId = "dm_1";

    const first = await runtime.runPromise(
      tryAcquireIMessageDeliveryLock({ ownerHandle, spaceId }),
    );
    expect(first).not.toBeNull();
    expect(
      await runtime.runPromise(
        tryAcquireIMessageDeliveryLock({ ownerHandle, spaceId }),
      ),
    ).toBeNull();

    await runtime.runPromise(
      releaseIMessageDeliveryLock({
        ownerHandle,
        spaceId,
        token: "not-the-owner",
      }),
    );
    expect(
      await runtime.runPromise(
        tryAcquireIMessageDeliveryLock({ ownerHandle, spaceId }),
      ),
    ).toBeNull();

    await runtime.runPromise(
      releaseIMessageDeliveryLock({
        ownerHandle,
        spaceId,
        token: first!,
      }),
    );
    expect(
      await runtime.runPromise(
        tryAcquireIMessageDeliveryLock({ ownerHandle, spaceId }),
      ),
    ).not.toBeNull();
  });
});
