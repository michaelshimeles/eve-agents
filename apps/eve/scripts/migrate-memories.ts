// One-off migration: copy the old blob-backed memories into Supermemory,
// and set the account's memory filter prompt while we're at it.
//
// Run from apps/eve/ (needs BLOB_READ_WRITE_TOKEN and SUPERMEMORY_API_KEY):
//   node --env-file=.env.local scripts/migrate-memories.ts

import { get } from "@vercel/blob";

const API_BASE = "https://api.supermemory.ai";
const CONTAINER_TAG = "micky";
const BLOB_PATH = "memory/memories.json";

interface LegacyMemory {
  key: string;
  value: string;
  updatedAt: string;
}

async function api(path: string, method: string, body: unknown): Promise<unknown> {
  const apiKey = process.env.SUPERMEMORY_API_KEY;
  if (!apiKey) throw new Error("SUPERMEMORY_API_KEY is not set.");
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supermemory ${method} ${path} failed (${response.status}): ${text}`);
  }
  return text.length > 0 ? JSON.parse(text) : null;
}

async function readLegacyMemories(): Promise<LegacyMemory[]> {
  const result = await get(BLOB_PATH, { access: "private", useCache: false });
  if (result === null || result.stream === null) return [];
  const text = await new Response(result.stream).text();
  const all = JSON.parse(text) as Record<string, LegacyMemory>;
  return Object.values(all);
}

async function main(): Promise<void> {
  console.log("Configuring Supermemory filter prompt...");
  await api("/v3/settings", "PATCH", {
    shouldLLMFilter: true,
    filterPrompt:
      "Personal assistant memory for a single user, Micky (Michael Shimeles). " +
      "The containerTag is 'micky'. We store durable facts, preferences, routines, " +
      "people, and project context about Micky. Ignore secrets and one-time codes.",
  });

  const legacy = await readLegacyMemories();
  if (legacy.length === 0) {
    console.log("No legacy blob memories found; nothing to migrate.");
    return;
  }

  console.log(`Migrating ${legacy.length} memories...`);
  // /v4/memories accepts up to 100 per call; legacy store is well under that.
  const result = await api("/v4/memories", "POST", {
    containerTag: CONTAINER_TAG,
    memories: legacy.map((memory) => ({
      content: `${memory.key.replaceAll("_", " ")}: ${memory.value}`,
      isStatic: true,
      metadata: { migratedKey: memory.key, migratedFrom: "blob", legacyUpdatedAt: memory.updatedAt },
    })),
  });

  console.log("Done:", JSON.stringify(result, null, 2));
  console.log(
    "Verify with a search or list, then the old blob at " +
      `'${BLOB_PATH}' can be deleted from the Vercel Blob store.`,
  );
}

await main();
