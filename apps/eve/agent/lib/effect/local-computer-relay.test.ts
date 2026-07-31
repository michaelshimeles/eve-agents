import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Db, type DbRow, type DbStatement } from "./db";
import {
  LocalComputerRelay,
  LocalComputerRelayLive,
  hashLocalComputerSecret,
} from "./local-computer-relay";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managed Ruth Local relay storage", () => {
  it("stores only hashes for pairing, device, and agent credentials", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://relay.test/database");
    vi.stubEnv(
      "RUTH_LOCAL_RELAY_SECRET",
      "relay-server-secret-with-at-least-thirty-two-characters",
    );
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn((sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });
      if (sql.includes("INSERT INTO local_computer_pair_tickets")) {
        return Effect.succeed([
          { expiresAt: "2026-07-30T22:00:00.000Z" },
        ] satisfies DbRow[]);
      }
      if (sql.includes("WITH locked AS")) {
        return Effect.succeed([
          {
            id: "mac-test-device",
            name: "Test Mac",
            platform: "darwin",
            architecture: "arm64",
            pairedAt: "2026-07-30T21:50:00.000Z",
            lastSeenAt: "2026-07-30T21:50:00.000Z",
            online: true,
          },
        ] satisfies DbRow[]);
      }
      if (sql.includes('agent_nonce AS "agentNonce"')) {
        return Effect.succeed([
          {
            id: "mac-test-device",
            agentNonce: "server-nonce-with-at-least-thirty-two-characters",
          },
        ] satisfies DbRow[]);
      }
      if (sql.includes("AND agent_token = $1")) {
        return Effect.succeed([{ id: "mac-test-device" }] satisfies DbRow[]);
      }
      return Effect.succeed([] as DbRow[]);
    });
    const transaction = vi.fn((_statements: readonly DbStatement[]) =>
      Effect.succeed([] as readonly DbRow[][]),
    );
    const database = Layer.succeed(Db, { query, transaction });
    const runtime = ManagedRuntime.make(
      LocalComputerRelayLive.pipe(Layer.provide(database)),
    );

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const relay = yield* LocalComputerRelay;
        const ticket = yield* relay.createPairTicket();
        yield* relay.enroll({
          ticketId: ticket.id,
          ticketSecret: ticket.secret,
          deviceId: "mac-test-device",
          deviceName: "Test Mac",
          deviceTokenHash: hashLocalComputerSecret("device-secret"),
          platform: "darwin",
          architecture: "arm64",
        });
        const credential = yield* relay.agentCredential();
        const authorizedDeviceId = yield* relay.authorizeAgent(
          credential.token,
        );
        yield* relay.enqueue(authorizedDeviceId, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        });
        return { ticket, credential, authorizedDeviceId };
      }),
    );

    expect(result.authorizedDeviceId).toBe("mac-test-device");
    expect(result.credential.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const ticketInsert = queries.find((entry) =>
      entry.sql.includes("INSERT INTO local_computer_pair_tickets"),
    );
    expect(ticketInsert?.params?.[1]).toBe(
      hashLocalComputerSecret(result.ticket.secret),
    );
    expect(ticketInsert?.params).not.toContain(result.ticket.secret);

    const enrollment = queries.find((entry) =>
      entry.sql.includes("WITH locked AS"),
    );
    expect(enrollment?.sql).toContain("pg_advisory_xact_lock");
    expect(enrollment?.params?.[1]).toBe(
      hashLocalComputerSecret(result.ticket.secret),
    );
    expect(enrollment?.params?.[7]).toMatch(/^[a-f0-9]{64}$/);
    expect(enrollment?.params).not.toContain(result.credential.token);

    const authorization = queries.find((entry) =>
      entry.sql.includes("AND agent_token = $1"),
    );
    expect(authorization?.params).toEqual([
      hashLocalComputerSecret(result.credential.token),
    ]);
    expect(
      queries.some(
        (entry) =>
          entry.sql.includes("DELETE FROM local_computer_relay_requests") &&
          entry.sql.includes("interval '1 day'"),
      ),
    ).toBe(true);
  });

  it("reports pairing unavailable without a database before opening a client", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const query = vi.fn((_sql: string, _params?: unknown[]) =>
      Effect.succeed([] as DbRow[]),
    );
    const transaction = vi.fn((_statements: readonly DbStatement[]) =>
      Effect.succeed([] as readonly DbRow[][]),
    );
    const runtime = ManagedRuntime.make(
      LocalComputerRelayLive.pipe(
        Layer.provide(Layer.succeed(Db, { query, transaction })),
      ),
    );

    const status = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* LocalComputerRelay).status();
      }),
    );

    expect(status).toEqual({ databaseConfigured: false, device: null });
    expect(query).not.toHaveBeenCalled();
  });

  it("reports a waiter cancellation distinctly from an acknowledged completion", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://relay.test/database");
    const query = vi.fn((sql: string, _params?: unknown[]) => {
      if (sql.includes("WITH completed AS")) {
        return Effect.succeed([
          { status: "cancelled" },
        ] satisfies DbRow[]);
      }
      return Effect.succeed([] as DbRow[]);
    });
    const transaction = vi.fn((_statements: readonly DbStatement[]) =>
      Effect.succeed([] as readonly DbRow[][]),
    );
    const runtime = ManagedRuntime.make(
      LocalComputerRelayLive.pipe(
        Layer.provide(Layer.succeed(Db, { query, transaction })),
      ),
    );

    const result = await runtime.runPromiseExit(
      Effect.gen(function* () {
        yield* (yield* LocalComputerRelay).complete(
          "mac-test-device",
          "f1088141-cb25-4260-89e6-51fa79aabf55",
          {
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"ok":true}',
          },
        );
      }),
    );

    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain('"reason":"expired"');
  });
});
