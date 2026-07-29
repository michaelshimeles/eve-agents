import { sendIMessageTypingAsDeployment } from "@/agent/lib/effect/imessage";
import { bearerToken, respondWith, stringField } from "@/lib/imessage-api";

// Router API: typing-indicator signals for paired deployments, with the same
// authorization model as ./send — the bearer secret must match the handle's
// registry row, so a deployment can only ever show typing to its own paired
// owner. The signal is cosmetic; deployments treat failures as ignorable.

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const secret = bearerToken(request);
  if (secret === null) return new Response("Unauthorized", { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  const state = stringField(body, "state");
  if (state !== "start" && state !== "stop") {
    return Response.json({ error: 'typing needs a state of "start" or "stop"' }, { status: 400 });
  }
  const phone = stringField(body, "phone");
  return respondWith(
    sendIMessageTypingAsDeployment({
      handle: stringField(body, "handle"),
      secret,
      state,
      ...(phone.length > 0 ? { phone } : {}),
    }),
  );
}
