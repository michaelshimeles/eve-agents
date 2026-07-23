import { requireWebAuth } from "@/lib/web-auth";

// Whether a newer agent template is available. Builder-deployed agents carry
// three env stamps: EVE_TEMPLATE_VERSION (content hash of the template they
// were assembled from), EVE_BUILDER_URL (the builder that deployed them),
// and EVE_PROJECT_NAME (for the deep link into the update flow). The
// personal app has none of these and always reports "no update".

/** The builder's latest version, memoized per instance for a few minutes. */
let cachedLatest: { version: string; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchLatestVersion(builderUrl: string): Promise<string | null> {
  if (cachedLatest !== null && Date.now() - cachedLatest.fetchedAt < CACHE_TTL_MS) {
    return cachedLatest.version;
  }
  const response = await fetch(new URL("/api/template-version", builderUrl), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { version?: unknown } | null;
  if (body === null || typeof body.version !== "string" || body.version.length === 0) {
    return null;
  }
  cachedLatest = { version: body.version, fetchedAt: Date.now() };
  return body.version;
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied !== null) return denied;

  const current = process.env.EVE_TEMPLATE_VERSION ?? "";
  const builderUrl = process.env.EVE_BUILDER_URL ?? "";
  if (current.length === 0 || builderUrl.length === 0) {
    return Response.json({ updateAvailable: false });
  }

  try {
    const latest = await fetchLatestVersion(builderUrl);
    if (latest === null) return Response.json({ updateAvailable: false });

    const projectName = process.env.EVE_PROJECT_NAME ?? "";
    const updateUrl = new URL(
      projectName.length > 0 ? `/?update=${encodeURIComponent(projectName)}` : "/",
      builderUrl,
    ).toString();
    return Response.json({
      updateAvailable: latest !== current,
      currentVersion: current,
      latestVersion: latest,
      updateUrl,
    });
  } catch {
    // The builder being unreachable should never break the manage page.
    return Response.json({ updateAvailable: false });
  }
}
