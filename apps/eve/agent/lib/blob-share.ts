import { put } from "@vercel/blob";

// Uploads whose whole point is a URL the owner (or the iMessage router, or a
// model provider) can fetch: shared files and rendered videos. A public Blob
// store hands out permanent public URLs. A private store refuses public
// uploads outright — its access mode is fixed at creation — so there the
// bytes are uploaded privately and the URL is a presigned link that expires.

/** How long a presigned link from a private store stays fetchable. */
const SIGNED_LINK_TTL_MS = 7 * 24 * 60 * 60_000;

export interface SharedUpload {
  readonly url: string;
  /** ISO timestamp when the link dies; null on public stores (permanent). */
  readonly expiresAt: string | null;
}

/**
 * The Blob API's refusal to write a public blob into a private store. The
 * SDK surfaces it as a plain BlobError carrying the server's message
 * ("Cannot use public access on a private store. ..."), so the message text
 * is the only discriminator available.
 */
function isPrivateStoreRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes("private store");
}

/**
 * Uploads bytes for hand-off and returns a URL anyone can fetch — permanent
 * on public stores, presigned with a TTL on private ones.
 */
export async function uploadForSharing(input: {
  /** Store pathname, e.g. `shared/report.csv`; a random suffix is added. */
  readonly pathname: string;
  readonly data: Buffer | string;
  readonly contentType?: string;
}): Promise<SharedUpload> {
  const options = {
    addRandomSuffix: true,
    ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
  };

  try {
    const blob = await put(input.pathname, input.data, { access: "public", ...options });
    return { url: blob.url, expiresAt: null };
  } catch (error) {
    if (!isPrivateStoreRefusal(error)) throw error;
  }

  const { issueSignedToken, presignUrl } = await import("@vercel/blob");
  const blob = await put(input.pathname, input.data, { access: "private", ...options });
  const validUntil = Date.now() + SIGNED_LINK_TTL_MS;
  // Sign for the stored pathname (it carries the random suffix), read-only.
  const signedToken = await issueSignedToken({
    pathname: blob.pathname,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(signedToken, {
    operation: "get",
    pathname: blob.pathname,
    access: "private",
    validUntil,
  });
  return { url: presignedUrl, expiresAt: new Date(validUntil).toISOString() };
}
