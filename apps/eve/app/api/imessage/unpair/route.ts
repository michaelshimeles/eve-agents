import { removeIMessageRegistration } from "@/agent/lib/effect/imessage";
import { bearerToken, respondWith, stringField } from "@/lib/imessage-api";

// Router API: a deployment retires its own registration. Authenticated the
// same way as ./send; after this the handle is a stranger again until it
// re-pairs.

export async function POST(request: Request): Promise<Response> {
  const secret = bearerToken(request);
  if (secret === null) return new Response("Unauthorized", { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  return respondWith(
    removeIMessageRegistration({
      handle: stringField(body, "handle"),
      secret,
    }),
  );
}
