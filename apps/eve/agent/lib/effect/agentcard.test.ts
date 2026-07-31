import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_CONNECTION_ROW,
  AgentcardStore,
  AgentcardStoreLive,
  agentcardAccessToken,
  agentcardConnectionRowName,
  agentcardStatus,
  parseAgentcardConnectTarget,
} from "./agentcard";
import { AgentcardConnectLive } from "./agentcard-connect";
import { AgentcardStoreMemory } from "./agentcard.testing";
import { Db, type DbRow, type DbStatement } from "./db";

function runtime() {
  vi.stubEnv("AGENTCARD_CLIENT_ID", "cl_1");
  vi.stubEnv("AGENTCARD_CLIENT_SECRET", "secret_1");
  return ManagedRuntime.make(
    Layer.mergeAll(
      AgentcardStoreMemory,
      AgentcardConnectLive.pipe(Layer.provide(AgentcardStoreMemory)),
    ),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connect target validation", () => {
  it("accepts exactly one normalized email or E.164 phone number", () => {
    expect(
      parseAgentcardConnectTarget({ email: " owner@example.com " }),
    ).toEqual({ email: "owner@example.com" });
    expect(
      parseAgentcardConnectTarget({ phone: " +14165550123 " }),
    ).toEqual({ phone: "+14165550123" });
  });

  it("rejects both, neither, malformed email, and non-E.164 phone", () => {
    expect(
      parseAgentcardConnectTarget({
        email: "owner@example.com",
        phone: "+14165550123",
      }),
    ).toBeNull();
    expect(parseAgentcardConnectTarget({})).toBeNull();
    expect(parseAgentcardConnectTarget({ email: "not-an-email" })).toBeNull();
    expect(parseAgentcardConnectTarget({ phone: "4165550123" })).toBeNull();
  });
});

describe("encrypted connection storage", () => {
  it("migrates an existing code-flow plaintext row on first read", async () => {
    const rt = runtime();
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        yield* store.write("tokens", {
          mode: "company",
          access_token: "legacy_at",
          refresh_token: "legacy_rt",
          expires_at: Date.now() + 3_600_000,
          connected_at: 1_700_000_000_000,
          user_id: "user_legacy",
          email: "owner@example.com",
          phone: null,
        });

        const status = yield* agentcardStatus();
        expect(status.connected).toBe(true);
        expect((yield* agentcardAccessToken()).token).toBe("legacy_at");
        expect(yield* store.read("tokens")).toBeNull();
        expect(yield* store.read(ACTIVE_CONNECTION_ROW)).toEqual({
          kind: "agentcard_active_connection",
          user_id: "user_legacy",
        });
        const raw = yield* store.read(
          agentcardConnectionRowName("user_legacy"),
        );
        expect(JSON.stringify(raw)).not.toContain("legacy_at");
        expect(JSON.stringify(raw)).not.toContain("legacy_rt");
      }),
    );
  });

  it("drops an old browser-OAuth row that has no Connect user id", async () => {
    const rt = runtime();
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        yield* store.write("tokens", {
          mode: "personal",
          access_token: "old_at",
          refresh_token: "old_rt",
          expires_at: Date.now() + 3_600_000,
          connected_at: 1_700_000_000_000,
          user_id: null,
          email: null,
        });

        const status = yield* agentcardStatus();
        expect(status.connected).toBe(false);
        expect(yield* store.read("tokens")).toBeNull();
      }),
    );
  });

  it("stays reconnectable when a rotated client secret cannot decrypt the old row", async () => {
    const rt = runtime();
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        yield* store.write("tokens", {
          mode: "company",
          access_token: "legacy_at",
          refresh_token: "legacy_rt",
          expires_at: Date.now() + 3_600_000,
          connected_at: 1_700_000_000_000,
          user_id: "user_legacy",
          email: "owner@example.com",
          phone: null,
        });
        expect((yield* agentcardStatus()).connected).toBe(true);
      }),
    );

    vi.stubEnv("AGENTCARD_CLIENT_SECRET", "rotated_secret");
    const status = await rt.runPromise(agentcardStatus());
    expect(status).toMatchObject({
      connected: false,
      canConnect: true,
      unavailableReason: null,
    });
  });

  it("reports which backend prerequisite is missing", async () => {
    vi.stubEnv("AGENTCARD_CLIENT_ID", "");
    vi.stubEnv("AGENTCARD_CLIENT_SECRET", "");
    const rt = ManagedRuntime.make(
      Layer.mergeAll(
        AgentcardStoreMemory,
        AgentcardConnectLive.pipe(Layer.provide(AgentcardStoreMemory)),
      ),
    );

    const status = await rt.runPromise(agentcardStatus());
    expect(status).toMatchObject({
      connected: false,
      canConnect: false,
      unavailableReason: "credentials",
    });
  });
});

describe("memory store conditional deletes", () => {
  it("takeMatching removes only on a field match", async () => {
    const rt = runtime();
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        yield* store.write("pending", { connect_id: "abc" });
        expect(
          yield* store.takeMatching("pending", "connect_id", "nope"),
        ).toBeNull();
        expect(
          yield* store.takeMatching("pending", "connect_id", "abc"),
        ).not.toBeNull();
        expect(yield* store.read("pending")).toBeNull();
      }),
    );
  });
});

describe("database connection activation", () => {
  it("commits the encrypted row, active pointer, and old-row cleanup in one transaction", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://agentcard.test/database");
    const query = vi.fn((_sql: string, _params?: unknown[]) =>
      Effect.succeed([] as DbRow[]),
    );
    const transaction = vi.fn((_statements: readonly DbStatement[]) =>
      Effect.succeed([] as readonly DbRow[][]),
    );
    const database = Layer.succeed(Db, { query, transaction });
    const rt = ManagedRuntime.make(
      AgentcardStoreLive.pipe(Layer.provide(database)),
    );

    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        yield* store.activateConnection({
          connectionName: "connection:user_new",
          connection: { encrypted: "ciphertext" },
          active: {
            kind: "agentcard_active_connection",
            user_id: "user_new",
          },
          previousConnectionName: "connection:user_old",
        });
      }),
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    const statements = transaction.mock.calls[0]?.[0];
    expect(statements).toHaveLength(3);
    expect(statements?.map((statement) => statement.params?.[0])).toEqual([
      "connection:user_new",
      ACTIVE_CONNECTION_ROW,
      "connection:user_old",
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("CREATE TABLE");
  });
});
