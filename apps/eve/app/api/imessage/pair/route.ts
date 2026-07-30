import { beginIMessagePairRequest } from "@/agent/lib/effect/imessage";
import { respondWith, stringField } from "@/lib/imessage-api";

// Router API: a deployment asks to pair a handle with itself. The router
// texts a 6-digit code to that handle from the shared line; the deployment
// proves it can read the phone by presenting the code to ./verify. No
// authentication beyond the OTP itself — knowing a phone number only gets
// you a text to that phone — and the per-handle hourly cap keeps the line
// from being used as a spam cannon.

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const supersede =
    body !== null && typeof body === "object" ? (body as { supersede?: unknown }).supersede : undefined;
  const supersedeHandle = stringField(supersede, "handle");
  const supersedeSecret = stringField(supersede, "secret");
  return respondWith(
    beginIMessagePairRequest({
      handle: stringField(body, "handle"),
      deploymentUrl: stringField(body, "deploymentUrl"),
      ...(supersedeHandle.length > 0 && supersedeSecret.length > 0
        ? { supersede: { handle: supersedeHandle, secret: supersedeSecret } }
        : {}),
    }),
    (result) => ({ pairingId: result.pairingId }),
  );
}
