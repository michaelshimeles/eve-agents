import { Effect } from "effect";

import {
  beginIMessagePairing,
  completeIMessagePairing,
  defaultRouterUrl,
  imessagePairingState,
  imessageRouterConfigured,
  sendIMessageReply,
  unpairIMessage,
  verifiedIMessagePairing,
} from "@/agent/lib/effect/imessage";
import { requestOrigin } from "@/lib/app-url";
import { imessageTranscriptAuthState } from "@/lib/imessage-auth";
import { respondWith, stringField } from "@/lib/imessage-api";
import { requireWebAuth } from "@/lib/web-auth";

// Backs Manage -> iMessage: pairing state, the OTP round trip against the
// router, unpairing, and a test text. This is the deployment side; the
// router-side endpoints live under ./pair, ./send, ./unpair, ./spectrum.

function hasDatabase(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

/**
 * The origin the router should call back on. The stable production domain
 * wins over the per-deployment URL; local dev falls back to the request's
 * own origin, which a locally-run router can reach.
 */
function deploymentOrigin(request: Request): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL ?? null;
  if (host !== null && host.length > 0) return `https://${host}`;
  return requestOrigin(request);
}

function stateResponse(request: Request): Promise<Response> {
  const transcriptAuth = imessageTranscriptAuthState(request);
  return respondWith(imessagePairingState(), (pairing) => ({
    hasDatabase: hasDatabase(),
    isRouter: imessageRouterConfigured(),
    routerUrl: pairing.routerUrl ?? defaultRouterUrl(requestOrigin(request)),
    pairing,
    transcriptAuth,
  }));
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  return stateResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;

  const body: unknown = await request.json().catch(() => null);
  const action = stringField(body, "action");

  if (action === "start") {
    const routerUrl =
      stringField(body, "routerUrl").trim() || defaultRouterUrl(requestOrigin(request)) || "";
    if (routerUrl.length === 0) {
      return Response.json(
        {
          error:
            "No iMessage router is configured. Set IMESSAGE_ROUTER_URL to the router deployment, or SPECTRUM_* credentials to make this deployment the router.",
        },
        { status: 400 },
      );
    }
    return respondWith(
      beginIMessagePairing({
        handle: stringField(body, "handle"),
        routerUrl,
        deploymentUrl: deploymentOrigin(request),
      }),
      (pairing) => ({ pairing }),
    );
  }

  if (action === "verify") {
    return respondWith(
      completeIMessagePairing({ code: stringField(body, "code") }),
      (pairing) => ({ pairing }),
    );
  }

  if (action === "unpair") {
    return respondWith(unpairIMessage(), (pairing) => ({ pairing }));
  }

  if (action === "test") {
    const program = Effect.gen(function* () {
      const pairing = yield* verifiedIMessagePairing();
      if (pairing === null) {
        return yield* Effect.fail(new Error("Not paired yet — pair a number first."));
      }
      yield* sendIMessageReply({
        handle: pairing.handle,
        text: "Ruth here — this deployment is paired and can text you. Reply any time.",
      });
      return pairing.handle;
    });
    return respondWith(program, (handle) => ({ ok: true, handle }));
  }

  return new Response("Invalid action", { status: 400 });
}
