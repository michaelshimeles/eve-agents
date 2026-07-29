import { Effect, Layer } from "effect";

import { AgentcardStore } from "./agentcard";

// In-memory AgentcardStore for tests: the same visible semantics as the
// Db-backed layer (one value per name; match-then-delete is trivially atomic
// here because everything is synchronous). Never imported by production code.

export const AgentcardStoreMemory = Layer.sync(AgentcardStore, () => {
  const rows = new Map<string, unknown>();
  const field = (value: unknown, name: string): string | null => {
    if (value === null || typeof value !== "object") return null;
    const candidate = (value as Record<string, unknown>)[name];
    return typeof candidate === "string" ? candidate : null;
  };
  return {
    available: () => true,
    read: (name) => Effect.sync(() => rows.get(name) ?? null),
    write: (name, value) => Effect.sync(() => void rows.set(name, value)),
    remove: (name) => Effect.sync(() => void rows.delete(name)),
    removeMatching: (name, jsonField, equals) =>
      Effect.sync(() => {
        if (field(rows.get(name), jsonField) === equals) rows.delete(name);
      }),
    take: (name) =>
      Effect.sync(() => {
        const value = rows.get(name) ?? null;
        rows.delete(name);
        return value;
      }),
    takeMatching: (name, jsonField, equals) =>
      Effect.sync(() => {
        const value = rows.get(name) ?? null;
        if (value === null || field(value, jsonField) !== equals) return null;
        rows.delete(name);
        return value;
      }),
  };
});
