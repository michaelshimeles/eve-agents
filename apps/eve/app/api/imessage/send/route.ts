import { sendIMessageAsDeployment } from "@/agent/lib/effect/imessage";
import { bearerToken, respondWith, stringField } from "@/lib/imessage-api";

// Router API: outbound sends for paired deployments. The bearer secret must
// match the handle's registry row, which is the whole authorization model —
// a deployment can only ever text its own paired owner, never anyone else on
// the shared line.

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const secret = bearerToken(request);
  if (secret === null) return new Response("Unauthorized", { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  const phone = stringField(body, "phone");
  return respondWith(
    sendIMessageAsDeployment({
      handle: stringField(body, "handle"),
      secret,
      text: stringField(body, "text"),
      ...(phone.length > 0 ? { phone } : {}),
    }),
  );
}
