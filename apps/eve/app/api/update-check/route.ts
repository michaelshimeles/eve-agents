import { TEMPLATE_STAMP } from "@/lib/eve-template-stamp";
import { requireWebAuth } from "@/lib/web-auth";

// Whether a newer agent template is available. Builder-deployed agents carry
// a baked TEMPLATE_STAMP (overwritten at assemble time) plus EVE_BUILDER_URL.
// The personal app has neither and always reports "no update".
//
// Updates require latest.release > current.release (monotonic integer from
// apps/eve/.eve-template-release). Current release comes from the baked
// stamp tied to this deployment's code — so a failed rebuild never suppresses
// the banner on the still-live older deployment. Env stamps are a legacy
// fallback for agents assembled before the baked stamp existed.

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

  const currentReleaseRaw = process.env.EVE_TEMPLATE_RELEASE ?? "";
  const current =
    TEMPLATE_STAMP.version.length > 0
      ? TEMPLATE_STAMP.version
      : (process.env.EVE_TEMPLATE_VERSION ?? "");
  const currentRelease =
    TEMPLATE_STAMP.release !== null
      ? TEMPLATE_STAMP.release
      : /^\d+$/.test(currentReleaseRaw)
        ? Number.parseInt(currentReleaseRaw, 10)
        : null;
  const builderUrl = process.env.EVE_BUILDER_URL ?? "";
  if (current.length === 0 || builderUrl.length === 0) {
    return Response.json({ updateAvailable: false });
  }

  try {
    const latest = await fetchLatestTemplate(builderUrl);
    if (latest === null) return Response.json({ updateAvailable: false });

    // Prefer monotonic releases. Agents that predate EVE_TEMPLATE_RELEASE
    // get a one-time banner whenever the builder publishes any release, so
    // they can enter the Update flow and receive a stamp — without using
    // unordered content-hash inequality (which would treat builder
    // rollbacks as upgrades). After that stamp, only release > current.
    const updateAvailable =
      latest.release !== null &&
      (currentRelease === null ? latest.release >= 1 : latest.release > currentRelease);

    const projectName = process.env.EVE_PROJECT_NAME ?? "";
    const updateUrl = new URL(
      projectName.length > 0 ? `/update?project=${encodeURIComponent(projectName)}` : "/update",
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
