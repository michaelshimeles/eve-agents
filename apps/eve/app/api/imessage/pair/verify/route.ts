import { verifyIMessagePairRequest } from "@/agent/lib/effect/imessage";
import { respondWith, stringField } from "@/lib/imessage-api";

// Router API: second half of pairing. The right code binds the handle to the
// deployment in the registry and mints the deployment's secret — returned
// exactly once here, like every webhook signing secret ever.

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  return respondWith(
    verifyIMessagePairRequest({
      pairingId: stringField(body, "pairingId"),
      code: stringField(body, "code"),
    }),
    (result) => ({ handle: result.handle, secret: result.secret }),
  );
}
