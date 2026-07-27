import { fetchIMessageAttachmentSigned } from "@/agent/lib/effect/imessage";
import { respondWithRaw } from "@/lib/imessage-api";

// Router API: inbound-attachment bytes behind a capability URL. Webhook
// deliveries carry attachment metadata only (never bytes); the deployment
// that received a delivery mints a short-lived HMAC over the attachment's
// identity with its pairing secret and hands the URL to the model as a file
// part — whoever presents the exact URL gets the bytes until it expires.
// `convert=jpeg` re-encodes HEIC/HEIF (the iPhone camera default) to JPEG,
// which model providers accept.

export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const signature = params.get("sig") ?? "";
  if (signature.length === 0) return new Response("Unauthorized", { status: 401 });
  return respondWithRaw(
    fetchIMessageAttachmentSigned({
      access: {
        handle: params.get("handle") ?? "",
        id: params.get("id") ?? "",
        phone: params.get("phone") ?? "",
        convert: params.get("convert") === "jpeg",
        expires: Number(params.get("expires") ?? "0"),
      },
      signature,
    }),
    (file) =>
      new Response(new Uint8Array(file.bytes), {
        headers: {
          "content-type": file.mimeType,
          "content-length": String(file.bytes.byteLength),
          "x-attachment-name": encodeURIComponent(file.name),
          "cache-control": "private, max-age=300",
        },
      }),
  );
}
