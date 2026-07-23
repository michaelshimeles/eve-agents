import { requireWebAuth } from "@/lib/web-auth";

// Whether a newer agent template is available. Builder-deployed agents carry
// env stamps for the template they were assembled from and the builder that
// deployed them. The personal app has none of these and always reports "no
// update". Updates require both a different content hash and a newer
// publishedAt, so rolling the builder back can't look like an upgrade.

interface LatestTemplate {
  version: string;
  publishedAt: string | null;
}

/** The builder's latest template identity, memoized per instance for a few minutes. */
let cachedLatest: { info: LatestTemplate; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchLatestTemplate(builderUrl: string): Promise<LatestTemplate | null> {
  if (cachedLatest !== null && Date.now() - cachedLatest.fetchedAt < CACHE_TTL_MS) {
    return cachedLatest.info;
  }
  const response = await fetch(new URL("/api/template-version", builderUrl), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    version?: unknown;
    publishedAt?: unknown;
  } | null;
  if (body === null || typeof body.version !== "string" || body.version.length === 0) {
    return null;
  }
  const info: LatestTemplate = {
    version: body.version,
    publishedAt: typeof body.publishedAt === "string" && body.publishedAt.length > 0
      ? body.publishedAt
      : null,
  };
  cachedLatest = { info, fetchedAt: Date.now() };
  return info;
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied !== null) return denied;

  const current = process.env.EVE_TEMPLATE_VERSION ?? "";
  const currentPublishedAt = process.env.EVE_TEMPLATE_PUBLISHED_AT ?? "";
  const builderUrl = process.env.EVE_BUILDER_URL ?? "";
  if (current.length === 0 || builderUrl.length === 0) {
    return Response.json({ updateAvailable: false });
  }

  try {
    const latest = await fetchLatestTemplate(builderUrl);
    if (latest === null) return Response.json({ updateAvailable: false });

    // Content-hash equality is definitive "up to date". When hashes differ,
    // require a newer publishedAt so a rolled-back builder isn't offered as
    // an upgrade. Agents that predate publishedAt keep the inequality check.
    const updateAvailable =
      latest.version !== current &&
      (currentPublishedAt.length === 0 ||
        latest.publishedAt === null ||
        latest.publishedAt > currentPublishedAt);

    const projectName = process.env.EVE_PROJECT_NAME ?? "";
    const updateUrl = new URL(
      projectName.length > 0 ? `/?update=${encodeURIComponent(projectName)}` : "/",
      builderUrl,
    ).toString();
    return Response.json({
      updateAvailable,
      currentVersion: current,
      latestVersion: latest.version,
      updateUrl,
    });
  } catch {
    // The builder being unreachable should never break the manage page.
    return Response.json({ updateAvailable: false });
  }
}
