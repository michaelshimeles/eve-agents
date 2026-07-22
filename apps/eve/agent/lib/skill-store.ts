import { get, put } from "@vercel/blob";
import { swrCache } from "./swr-cache";

export interface StoredSkill {
  name: string;
  description: string;
  markdown: string;
  updatedAt: string;
}

// Chat-created skills live in one private JSON blob, separate from memories.
// The dynamic resolver in agent/skills/custom.ts serves them each turn.
const BLOB_PATH = "skills/skills.json";

async function readAll(): Promise<Record<string, StoredSkill>> {
  const result = await get(BLOB_PATH, { access: "private", useCache: false });
  if (result === null || result.stream === null) return {};
  const text = await new Response(result.stream).text();
  return JSON.parse(text) as Record<string, StoredSkill>;
}

async function writeAll(skills: Record<string, StoredSkill>): Promise<void> {
  await put(BLOB_PATH, JSON.stringify(skills, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

// The list is read on every turn to advertise chat-created skills; cache it
// so the blob fetch stays off the turn's critical path.
const listCache = swrCache(60_000, readAll);

export const skillStore = {
  async list(): Promise<StoredSkill[]> {
    const all = await listCache.get();
    return Object.values(all).sort((a, b) => a.name.localeCompare(b.name));
  },

  async put(skill: Omit<StoredSkill, "updatedAt">): Promise<StoredSkill> {
    const all = await readAll();
    const stored: StoredSkill = { ...skill, updatedAt: new Date().toISOString() };
    all[skill.name] = stored;
    await writeAll(all);
    listCache.invalidate();
    return stored;
  },

  async delete(name: string): Promise<boolean> {
    const all = await readAll();
    if (!(name in all)) return false;
    delete all[name];
    await writeAll(all);
    listCache.invalidate();
    return true;
  },
};
