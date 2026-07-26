// Live language-model catalog from the Vercel AI Gateway.
//
// The chat picker and the agent default both read from here so new Gateway
// models show up without a code change. The public REST catalog needs no
// credentials (same source as `gateway.getAvailableModels()`), and a short
// in-process TTL keeps the picker snappy without hammering the endpoint.

/** Last-resort default when the catalog is unreachable. */
export const FALLBACK_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5";

/**
 * Preferred chat default family. When several Claude Sonnet ids are in the
 * catalog, the highest version wins (sonnet-5 over sonnet-4.6, etc.).
 */
const PREFERRED_DEFAULT_FAMILY = {
  provider: "anthropic",
  family: "sonnet",
} as const;

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

export interface GatewayModelOption {
  id: string;
  name: string;
  description: string | null;
  pricing: { input: string; output: string } | null;
  /** Unix seconds when the model was released (Gateway catalog). */
  released: number | null;
}

export interface GatewayModelCatalog {
  models: GatewayModelOption[];
  /** Newest preferred-family id, or {@link FALLBACK_DEFAULT_MODEL_ID}. */
  defaultModel: string;
  fetchedAt: number;
}

interface GatewayRestModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  type?: unknown;
  released?: unknown;
  created?: unknown;
  pricing?: unknown;
}

let cached: GatewayModelCatalog | null = null;
let inflight: Promise<GatewayModelCatalog> | null = null;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pricingOf(value: unknown): GatewayModelOption["pricing"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const input = asString(record.input);
  const output = asString(record.output);
  if (input === null || output === null) return null;
  return { input, output };
}

/**
 * Parse `anthropic/claude-sonnet-4.6` → `[4, 6]`. Returns null for ids that
 * aren't a clean `provider/claude-{family}-{version}` release (previews,
 * dated snapshots, other product lines).
 */
export function modelFamilyVersion(
  id: string,
  provider: string,
  family: string,
): number[] | null {
  const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = id.match(
    new RegExp(`^${provider}/claude-${escaped}-(\\d+(?:\\.\\d+)*)$`, "i"),
  );
  if (match?.[1] === undefined) return null;
  return match[1].split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/** Highest-version id in `provider/claude-{family}-*` form, or null. */
export function latestFamilyModel(
  ids: readonly string[],
  provider: string,
  family: string,
): string | null {
  let best: { id: string; version: number[] } | null = null;
  for (const id of ids) {
    const version = modelFamilyVersion(id, provider, family);
    if (version === null) continue;
    if (best === null || compareVersions(version, best.version) > 0) {
      best = { id, version };
    }
  }
  return best?.id ?? null;
}

export function resolveDefaultModelId(ids: readonly string[]): string {
  const preferred = latestFamilyModel(
    ids,
    PREFERRED_DEFAULT_FAMILY.provider,
    PREFERRED_DEFAULT_FAMILY.family,
  );
  if (preferred !== null) return preferred;
  // Never return an id that isn't in a nonempty catalog — that would make
  // automatic channels and stale-selection resets fail despite usable models.
  if (ids.includes(FALLBACK_DEFAULT_MODEL_ID)) return FALLBACK_DEFAULT_MODEL_ID;
  if (ids[0] !== undefined) return ids[0];
  return FALLBACK_DEFAULT_MODEL_ID;
}

function mapRestModel(raw: GatewayRestModel): GatewayModelOption | null {
  const id = asString(raw.id);
  const name = asString(raw.name);
  if (id === null || name === null) return null;
  if ((asString(raw.type) ?? "language") !== "language") return null;
  return {
    id,
    name,
    description: asString(raw.description),
    pricing: pricingOf(raw.pricing),
    released: asFiniteNumber(raw.released) ?? asFiniteNumber(raw.created),
  };
}

async function fetchCatalog(): Promise<GatewayModelCatalog> {
  const response = await fetch(GATEWAY_MODELS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Gateway models HTTP ${response.status}`);
  }
  const body = (await response.json()) as { data?: unknown };
  const rows = Array.isArray(body.data) ? body.data : [];
  const models = rows
    .map((row) => mapRestModel(row as GatewayRestModel))
    .filter((model): model is GatewayModelOption => model !== null)
    // Newest releases first so the picker surfaces drops without scrolling.
    .sort((left, right) => (right.released ?? 0) - (left.released ?? 0));

  return {
    models,
    defaultModel: resolveDefaultModelId(models.map((model) => model.id)),
    fetchedAt: Date.now(),
  };
}

/**
 * Cached catalog. Concurrent callers share one in-flight fetch; failures keep
 * the previous good catalog when one exists.
 */
export async function getGatewayModelCatalog(): Promise<GatewayModelCatalog> {
  if (cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  if (inflight === null) {
    inflight = fetchCatalog()
      .then((catalog) => {
        cached = catalog;
        return catalog;
      })
      .catch((error: unknown) => {
        if (cached !== null) return cached;
        throw error;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Preferred default only — never throws; falls back when the catalog is down. */
export async function getDefaultModelId(): Promise<string> {
  try {
    const catalog = await getGatewayModelCatalog();
    return catalog.defaultModel;
  } catch {
    return FALLBACK_DEFAULT_MODEL_ID;
  }
}
