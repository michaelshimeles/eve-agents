import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  Agentcard,
  AgentcardStore,
  StoredTokens,
  TOKENS_ROW,
  agentcardAccessToken,
  agentcardStatus,
  startCompanyConnect,
} from "./agentcard";
import { AgentcardPersonalLive } from "./agentcard-personal";
import { AgentcardStoreMemory } from "./agentcard.testing";

// The mode tag decides which endpoint a stored grant is sent to, so decoding
// and mode filtering are admission control, not formatting.

const decodeStored = Schema.decodeUnknownEffect(StoredTokens);

function personalRuntime() {
  // Same layer reference in both places: Effect memoizes it, so the personal
  // layer and the test program see one shared in-memory store.
  return ManagedRuntime.make(
    Layer.mergeAll(
      AgentcardStoreMemory,
      AgentcardPersonalLive.pipe(Layer.provide(AgentcardStoreMemory)),
    ),
  );
}

/** A grant row as this app wrote it before the mode tag existed. */
const legacyRow = {
  client_id: "cid_1",
  client_secret: null,
  access_token: "at_1",
  refresh_token: "rt_1",
  expires_at: Date.now() + 3_600_000,
  connected_at: 1_700_000_000_000,
};

describe("StoredTokens mode tag", () => {
  it("decodes an untagged (pre-company) row as personal", async () => {
    const decoded = await Effect.runPromise(decodeStored(legacyRow));
    expect(decoded.mode).toBe("personal");
  });

  it("round-trips a company row", async () => {
    const decoded = await Effect.runPromise(
      decodeStored({
        mode: "company",
        client_id: null,
        client_secret: null,
        access_token: "at_2",
        refresh_token: "rt_2",
        expires_at: null,
        connected_at: 1_700_000_000_000,
        user_id: "user_1",
        email: "o@example.com",
      }),
    );
    expect(decoded.mode).toBe("company");
    expect(decoded.user_id).toBe("user_1");
  });
});

describe("personal layer over the memory store", () => {
  it("reports connected and serves a fresh token", async () => {
    const rt = personalRuntime();
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        yield* store.write(TOKENS_ROW, legacyRow);
        const status = yield* agentcardStatus();
        expect(status.connected).toBe(true);
        const { token } = yield* agentcardAccessToken();
        expect(token).toBe("at_1");
      }),
    );
  });

  it("treats a company-tagged grant as not connected (mode mismatch)", async () => {
    const rt = personalRuntime();
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        yield* store.write(TOKENS_ROW, {
          ...legacyRow,
          mode: "company",
          user_id: "u",
          email: null,
        });
        const status = yield* agentcardStatus();
        expect(status.connected).toBe(false);
      }),
    );
  });

  it("fails company accessors with wrong_mode", async () => {
    const rt = personalRuntime();
    const exit = await rt.runPromiseExit(startCompanyConnect());
    expect(exit._tag).toBe("Failure");
  });

  it("exposes the personal flow", async () => {
    const rt = personalRuntime();
    const flow = await rt.runPromise(
      Effect.gen(function* () {
        const service = yield* Agentcard;
        return service.flow;
      }),
    );
    expect(flow.mode).toBe("personal");
  });
});

describe("memory store take semantics", () => {
  it("takeMatching removes only on a field match", async () => {
    const rt = personalRuntime();
    await rt.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentcardStore;
        yield* store.write("pending", { state: "abc", verifier: "v" });
        expect(yield* store.takeMatching("pending", "state", "nope")).toBeNull();
        expect(yield* store.takeMatching("pending", "state", "abc")).not.toBeNull();
        expect(yield* store.read("pending")).toBeNull();
      }),
    );
  });
});
