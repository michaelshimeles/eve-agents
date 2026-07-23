import { requireWebAuth } from "@/lib/web-auth";

// Whether a newer agent template is available. Builder-deployed agents carry
// env stamps for the template they were assembled from and the builder that
// deployed them. The personal app has none of these and always reports "no
// update". Updates require latest.release > current.release (monotonic
// integer from apps/eve/.eve-template-release), so restoring older template
// content can't look like an upgrade.

interface LatestTemplate {
  version: string;
  release: number | null;
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
    release?: unknown;
  } | null;
  if (body === null || typeof body.version !== "string" || body.version.length === 0) {
    return null;
  }
  const release =
    typeof body.release === "number" && Number.isFinite(body.release)
      ? body.release
      : typeof body.release === "string" && /^\d+$/.test(body.release)
        ? Number.parseInt(body.release, 10)
        : null;
  const info: LatestTemplate = { version: body.version, release };
  cachedLatest = { info, fetchedAt: Date.now() };
  return info;
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied !== null) return denied;

  const current = process.env.EVE_TEMPLATE_VERSION ?? "";
  const currentReleaseRaw = process.env.EVE_TEMPLATE_RELEASE ?? "";
  const builderUrl = process.env.EVE_BUILDER_URL ?? "";
  if (current.length === 0 || builderUrl.length === 0) {
    return Response.json({ updateAvailable: false });
  }

  try {
    const latest = await fetchLatestTemplate(builderUrl);
    if (latest === null) return Response.json({ updateAvailable: false });

    const currentRelease = /^\d+$/.test(currentReleaseRaw)
      ? Number.parseInt(currentReleaseRaw, 10)
      : null;

    // Prefer monotonic release ordering. Agents that predate the release
    // stamp fall back to content-hash inequality so they still see a banner
    // once — after one update they carry a release and stay safe.
    const updateAvailable =
      latest.release !== null && currentRelease !== null
        ? latest.release > currentRelease
        : latest.version !== current;

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
