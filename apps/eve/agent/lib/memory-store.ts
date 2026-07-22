// Long-term memory backed by Supermemory (https://supermemory.ai).
// Single-user agent, so everything lives under one container tag.

import { swrCache } from "./swr-cache";

const API_BASE = "https://api.supermemory.ai";
const CONTAINER_TAG = "micky";

export interface MemoryProfile {
  static: string[];
  dynamic: string[];
}

export interface MemorySearchResult {
  id: string;
  content: string;
  similarity: number;
  updatedAt: string | null;
}

export interface MemoryEntry {
  id: string;
  content: string;
  permanent: boolean;
  updatedAt: string | null;
}

class SupermemoryError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SupermemoryError";
    this.status = status;
  }
}

async function api<T>(path: string, method: string, body?: unknown): Promise<T> {
  const apiKey = process.env.SUPERMEMORY_API_KEY;
  if (!apiKey) throw new Error("SUPERMEMORY_API_KEY is not set.");

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new SupermemoryError(`Supermemory ${method} ${path} failed (${response.status}): ${text}`, response.status);
  }
  return (text.length > 0 ? JSON.parse(text) : null) as T;
}

interface RawSearchResult {
  id?: string;
  documentId?: string;
  docId?: string;
  memory?: string;
  chunk?: string;
  content?: string;
  similarity?: number;
  score?: number;
  updatedAt?: string;
}

interface RawMemoryEntry {
  id?: string;
  memory?: string;
  isStatic?: boolean;
  isForgotten?: boolean;
  isLatest?: boolean;
  updatedAt?: string;
}

// The profile is injected into every turn's instructions; cache it so the
// Supermemory round-trip stays off the turn's critical path. Writes
// invalidate it, and Supermemory folds new memories into the profile
// asynchronously anyway, so a short stale window is invisible.
const profileCache = swrCache(60_000, async (): Promise<MemoryProfile> => {
  const result = await api<{ profile?: { static?: string[]; dynamic?: string[] } }>("/v4/profile", "POST", {
    containerTag: CONTAINER_TAG,
  });
  return {
    static: result.profile?.static ?? [],
    dynamic: result.profile?.dynamic ?? [],
  };
});

export const memoryStore = {
  /** Create a memory directly (immediately searchable). Returns the backing document id. */
  async add(content: string, options?: { permanent?: boolean }): Promise<{ documentId: string }> {
    const result = await api<{ documentId?: string }>("/v4/memories", "POST", {
      containerTag: CONTAINER_TAG,
      memories: [{ content, isStatic: options?.permanent ?? false }],
    });
    profileCache.invalidate();
    return { documentId: result.documentId ?? "" };
  },

  async search(query: string): Promise<MemorySearchResult[]> {
    const result = await api<{ results?: RawSearchResult[] }>("/v4/search", "POST", {
      q: query,
      containerTag: CONTAINER_TAG,
      searchMode: "hybrid",
    });
    return (result.results ?? []).map((raw) => ({
      id: raw.id ?? raw.docId ?? raw.documentId ?? "",
      content: raw.memory ?? raw.chunk ?? raw.content ?? "",
      similarity: raw.similarity ?? raw.score ?? 0,
      updatedAt: raw.updatedAt ?? null,
    }));
  },

  /** Auto-maintained user profile: stable facts plus recent context. */
  async profile(): Promise<MemoryProfile> {
    return await profileCache.get();
  },

  /** Every active memory entry, with the ids `delete` needs. */
  async list(): Promise<MemoryEntry[]> {
    // This endpoint still takes the plural containerTags form.
    const result = await api<{ memoryEntries?: RawMemoryEntry[] }>("/v4/memories/list", "POST", {
      containerTags: [CONTAINER_TAG],
      limit: 200,
    });
    return (result.memoryEntries ?? [])
      .filter((raw) => raw.isForgotten !== true && raw.isLatest !== false)
      .map((raw) => ({
        id: raw.id ?? "",
        content: raw.memory ?? "",
        permanent: raw.isStatic ?? false,
        updatedAt: raw.updatedAt ?? null,
      }));
  },

  async delete(memoryId: string): Promise<boolean> {
    try {
      const result = await api<{ forgotten?: boolean }>("/v4/memories", "DELETE", {
        containerTag: CONTAINER_TAG,
        id: memoryId,
      });
      profileCache.invalidate();
      return result.forgotten ?? true;
    } catch (error) {
      if (error instanceof SupermemoryError && error.status === 404) return false;
      throw error;
    }
  },
};
