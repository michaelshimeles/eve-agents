// A local stand-in for the Vercel Blob control API, for exercising file
// sharing without a real store. Point the SDK here with VERCEL_BLOB_API_URL
// and any well-formed token (e.g. vercel_blob_rw_TESTSTORE123_secretsecret).
//
// The store's access mode is simulated with STORE_ACCESS=private|public
// (default private — the mode that used to break share_file): a public
// upload against a private store is refused with the Blob API's own error
// shape, and a private upload succeeds and can then be presigned via
// /signed-token, exactly like production.
//
//   STORE_ACCESS=private node scripts/blob-stub.mjs        # 127.0.0.1:4548
//   VERCEL_BLOB_API_URL=http://127.0.0.1:4548 \
//   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_TESTSTORE123_secretsecret npm run dev
//
// Endpoints:
//   PUT    /<pathname>     (x-vercel-blob-access header) -> PutBlobResult | error
//   POST   /signed-token                                 -> token material
//   GET    /v1/uploads                                   -> { uploads: [...] }
//   DELETE /v1/uploads                                   -> { ok }

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.PORT ?? "4548", 10);
const STORE_ACCESS = process.env.STORE_ACCESS === "public" ? "public" : "private";
const STORE_ID = "teststore123";

/** @type {{ pathname: string, access: string, size: number, contentType: string | null, at: string }[]} */
const uploads = [];

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function withRandomSuffix(pathname) {
  const dot = pathname.lastIndexOf(".");
  const suffix = `-${randomUUID().slice(0, 8)}`;
  return dot > 0 ? `${pathname.slice(0, dot)}${suffix}${pathname.slice(dot)}` : `${pathname}${suffix}`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const route = `${request.method} ${url.pathname}`;

  try {
    if (request.method === "PUT") {
      const access = request.headers["x-vercel-blob-access"] ?? "public";
      if (access !== STORE_ACCESS) {
        // The Blob API's own refusal, message included, so the SDK surfaces
        // the exact production error text.
        console.log(`[blob-stub] refused ${access} upload (store is ${STORE_ACCESS})`);
        return json(response, 400, {
          error: {
            code: "bad_request",
            message: `Cannot use ${access} access on a ${STORE_ACCESS} store. The store is configured with ${STORE_ACCESS} access.`,
          },
        });
      }
      const body = await readBody(request);
      // The SDK carries the pathname as a query param (`PUT /?pathname=…`);
      // older clients used the URL path. Accept both.
      let pathname = url.searchParams.get("pathname") ?? decodeURIComponent(url.pathname.replace(/^\//, ""));
      if (request.headers["x-add-random-suffix"] === "1") pathname = withRandomSuffix(pathname);
      const record = {
        pathname,
        access,
        size: body.byteLength,
        contentType: typeof request.headers["x-content-type"] === "string" ? request.headers["x-content-type"] : null,
        at: new Date().toISOString(),
      };
      uploads.push(record);
      console.log(`[blob-stub] put ${access} ${pathname} (${body.byteLength} bytes)`);
      const host = access === "private" ? `${STORE_ID}.private.blob.vercel-storage.com` : `${STORE_ID}.public.blob.vercel-storage.com`;
      const blobUrl = `https://${host}/${pathname}`;
      return json(response, 200, {
        url: blobUrl,
        downloadUrl: `${blobUrl}?download=1`,
        pathname,
        contentType: record.contentType ?? "application/octet-stream",
        contentDisposition: `attachment; filename="${pathname.split("/").at(-1)}"`,
      });
    }

    if (route === "POST /signed-token") {
      const body = JSON.parse((await readBody(request)).toString("utf8"));
      const payload = {
        storeId: `store_${STORE_ID}`,
        pathname: body.pathname ?? "*",
        operations: body.operations ?? ["get"],
        validUntil: body.validUntil ?? Date.now() + 60 * 60_000,
      };
      console.log(`[blob-stub] signed-token for ${payload.pathname} until ${new Date(payload.validUntil).toISOString()}`);
      return json(response, 200, {
        clientSigningToken: `vcs_${randomUUID().replaceAll("-", "")}`,
        delegationToken: `${base64Url(JSON.stringify(payload))}.stubsig`,
      });
    }

    if (route === "GET /v1/uploads") {
      return json(response, 200, { uploads });
    }

    if (route === "DELETE /v1/uploads") {
      uploads.length = 0;
      return json(response, 200, { ok: true });
    }

    return json(response, 404, { error: { code: "not_found", message: `no route for ${route}` } });
  } catch (error) {
    console.error(`[blob-stub] ${route} failed`, error);
    return json(response, 500, {
      error: { code: "unknown_error", message: error instanceof Error ? error.message : String(error) },
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[blob-stub] listening at http://127.0.0.1:${PORT} as a ${STORE_ACCESS} store`);
  console.log(`[blob-stub] point the SDK here with VERCEL_BLOB_API_URL=http://127.0.0.1:${PORT}`);
});
