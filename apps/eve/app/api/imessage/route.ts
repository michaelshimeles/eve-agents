import { Effect } from "effect";

import {
  type VerifiedPairing,
  beginIMessagePairing,
  completeIMessagePairing,
  defaultRouterUrl,
  imessagePairingState,
  imessageRouterConfigured,
  sendIMessageReply,
  unpairIMessage,
  verifiedIMessagePairing,
} from "@/agent/lib/effect/imessage";
import { runApp } from "@/agent/lib/effect/runtime";
import { fetchValidatedDeployment } from "@/agent/lib/effect/imessage/security";
import {
  IMESSAGE_FEATURE_FLAGS,
  IMESSAGE_RICH_EXPERIENCE_FLAGS,
  iMessageVoiceReplyMode,
  isIMessageFeatureEnabled,
  setIMessageFeatureFlag,
  setIMessageRichExperienceEnabled,
  setIMessageVoiceReplyMode,
  type IMessageFeatureFlag,
  type IMessageVoiceReplyMode,
} from "@/agent/lib/imessage-feature-flags";
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
 * The exact deployment origin the router should call back on. Never derive a
 * staging callback from the production-domain variable: doing so crosses the
 * environment boundary and can forward staging messages into production.
 */
function deploymentOrigin(request: Request): string {
  const host = process.env.VERCEL_URL ?? null;
  if (host !== null && host.length > 0) return `https://${host}`;
  return requestOrigin(request);
}

async function routerOperations(
  pairing: VerifiedPairing | null,
): Promise<unknown> {
  if (pairing === null) return null;
  try {
    const response = await fetchValidatedDeployment(
      pairing.routerUrl,
      "/api/imessage/operations",
      {
        headers: { authorization: `Bearer ${pairing.secret}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function stateResponse(request: Request): Promise<Response> {
  const transcriptAuth = imessageTranscriptAuthState(request);
  const pairing = await runApp(imessagePairingState());
  const verified = await runApp(verifiedIMessagePairing());
  const [operations, voiceReplyMode, featureEntries] = await Promise.all([
    routerOperations(verified),
    iMessageVoiceReplyMode(),
    Promise.all(
      IMESSAGE_FEATURE_FLAGS.map(
        async (flag) => [flag, await isIMessageFeatureEnabled(flag)] as const,
      ),
    ),
  ]);
  const featureFlags = Object.fromEntries(featureEntries) as Record<
    IMessageFeatureFlag,
    boolean
  >;
  return Response.json({
    hasDatabase: hasDatabase(),
    isRouter: imessageRouterConfigured(),
    routerUrl: pairing.routerUrl ?? defaultRouterUrl(requestOrigin(request)),
    pairing,
    operations,
    featureFlags,
    richExperienceEnabled: IMESSAGE_RICH_EXPERIENCE_FLAGS.every(
      (flag) => featureFlags[flag],
    ),
    voiceReplyMode,
    transcriptAuth,
  });
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
    const configuredRouter = defaultRouterUrl(requestOrigin(request));
    const localOverride =
      process.env.IMESSAGE_ALLOW_INSECURE_LOCAL_URLS?.trim().toLowerCase() === "true"
        ? stringField(body, "routerUrl").trim()
        : "";
    const routerUrl = localOverride || configuredRouter || "";
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

  if (action === "feature") {
    const flag = stringField(body, "flag") as IMessageFeatureFlag;
    if (!IMESSAGE_FEATURE_FLAGS.includes(flag)) {
      return Response.json({ error: "Unknown iMessage feature flag" }, { status: 400 });
    }
    await setIMessageFeatureFlag(flag, stringField(body, "enabled") === "true");
    return Response.json({ ok: true, flag });
  }

  if (action === "feature_bundle") {
    const enabled = stringField(body, "enabled") === "true";
    await setIMessageRichExperienceEnabled(enabled);
    return Response.json({ ok: true, enabled });
  }

  if (action === "voice_mode") {
    const mode = stringField(body, "mode") as IMessageVoiceReplyMode;
    if (mode !== "mirror" && mode !== "text" && mode !== "always") {
      return Response.json({ error: "Unknown voice reply mode" }, { status: 400 });
    }
    await setIMessageVoiceReplyMode(mode);
    return Response.json({ ok: true, mode });
  }

  if (action === "replay" || action === "stop_location") {
    const pairing = await runApp(verifiedIMessagePairing());
    if (pairing === null) {
      return Response.json({ error: "Pair iMessage first" }, { status: 409 });
    }
    const response = await fetchValidatedDeployment(
      pairing.routerUrl,
      "/api/imessage/operations",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${pairing.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action, id: stringField(body, "id") }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const result = await response.json().catch(() => null);
    return Response.json(result, { status: response.status });
  }

  return new Response("Invalid action", { status: 400 });
}
