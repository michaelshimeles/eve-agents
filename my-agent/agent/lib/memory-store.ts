import { get, put } from "@vercel/blob";

export interface Memory {
  key: string;
  value: string;
  updatedAt: string;
}

// All long-term memories live in one private JSON blob. Single-user agent,
// so no tenant scoping and no contention concerns.
const BLOB_PATH = "memory/memories.json";

async function readAll(): Promise<Record<string, Memory>> {
  // useCache: false — reads must see the latest write, not the CDN copy.
  const result = await get(BLOB_PATH, { access: "private", useCache: false });
  if (result === null || result.stream === null) return {};
  const text = await new Response(result.stream).text();
  return JSON.parse(text) as Record<string, Memory>;
}

async function writeAll(memories: Record<string, Memory>): Promise<void> {
  await put(BLOB_PATH, JSON.stringify(memories, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export const memoryStore = {
  async list(): Promise<Memory[]> {
    const all = await readAll();
    return Object.values(all).sort((a, b) => a.key.localeCompare(b.key));
  },

  async put(key: string, value: string): Promise<Memory> {
    const all = await readAll();
    const memory: Memory = { key, value, updatedAt: new Date().toISOString() };
    all[key] = memory;
    await writeAll(all);
    return memory;
  },

  async delete(key: string): Promise<boolean> {
    const all = await readAll();
    if (!(key in all)) return false;
    delete all[key];
    await writeAll(all);
    return true;
  },
};
