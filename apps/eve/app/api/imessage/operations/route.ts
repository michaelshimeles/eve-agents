import { randomUUID } from "node:crypto";

import { start } from "workflow/api";

import { resolveIMessageDeploymentActor } from "@/agent/lib/effect/imessage";
import { probeAdvancedIMessage } from "@/agent/lib/effect/imessage/advanced";
import {
  listActiveIMessageLocationWatches,
  readLatestIMessageLocationSnapshot,
  stopIMessageLocationWatch,
} from "@/agent/lib/effect/imessage/location";
import { iMessageOperationalOverview } from "@/agent/lib/effect/imessage/operations";
import {
  iMessageDeadLetters,
  iMessageIngressStats,
  iMessageProviderHealth,
  replayIMessageDeadLetter,
} from "@/agent/lib/effect/imessage/store";
import { runApp } from "@/agent/lib/effect/runtime";
import { imessageIngressWorkflow } from "@/app/workflows/imessage-ingress";
import { bearerToken } from "@/lib/imessage-api";

const noStore = { "cache-control": "private, no-store" };

async function actorFor(request: Request) {
  const secret = bearerToken(request);
  return secret === null || secret.length === 0
    ? null
    : runApp(resolveIMessageDeploymentActor(secret));
}

export async function GET(request: Request): Promise<Response> {
  const actor = await actorFor(request);
  if (actor === null) return new Response("Unauthorized", { status: 401 });
  // The store health reads also apply idempotent runtime migrations. Complete
  // those before querying the broader overview so a brand-new router cannot
  // race its first Manage health request against table creation.
  const [inbox, eventPumps, deadLetters] = await Promise.all([
    runApp(iMessageIngressStats()),
    runApp(iMessageProviderHealth()),
    runApp(iMessageDeadLetters()),
  ]);
  const [advanced, overview, locationWatches] = await Promise.all([
    runApp(probeAdvancedIMessage(actor.handle)),
    runApp(iMessageOperationalOverview()),
    runApp(listActiveIMessageLocationWatches(actor.deploymentUrl)),
  ]);
  return Response.json(
    {
      inbox,
      eventPumps,
      deadLetters,
      advanced,
      locationWatches,
      ...overview,
      highLevelConfigured:
        (process.env.SPECTRUM_PROJECT_ID?.trim().length ?? 0) > 0 ||
        (process.env.SPECTRUM_API_BASE_URL?.trim().length ?? 0) > 0,
      calls: {
        available: false,
        reason: "Awaiting a documented Photon call-control SDK",
      },
      universalMiniApps: {
        ready:
          (process.env.IMESSAGE_INTERACTION_PUBLIC_URL?.trim().length ?? 0) > 0,
      },
      brandedExtension: {
        ready:
          (process.env.PHOTON_IMESSAGE_EXTENSION_BUNDLE_ID?.trim().length ?? 0) > 0 &&
          (process.env.PHOTON_IMESSAGE_APPLE_TEAM_ID?.trim().length ?? 0) > 0,
      },
      retention: {
        processedIngressHours: 24,
        failedIngressDays: 7,
        interactionExpiryHours: 24,
        sensitiveInteractionExpiryMinutes: 10,
        groupMemoryDays: 30,
      },
    },
    { headers: noStore },
  );
}

export async function POST(request: Request): Promise<Response> {
  const actor = await actorFor(request);
  if (actor === null) return new Response("Unauthorized", { status: 401 });
  const body = (await request.json().catch(() => null)) as
    | { action?: unknown; id?: unknown; phone?: unknown }
    | null;
  if (
    body?.action === "read_latest_location" &&
    typeof body.phone === "string" &&
    body.phone.trim().length > 0
  ) {
    const latest = await runApp(
      readLatestIMessageLocationSnapshot({
        ownerDeployment: actor.deploymentUrl,
        conversationKey: `dm:${body.phone.trim()}:${actor.handle}`,
      }),
    );
    return latest === null
      ? Response.json(
          { error: "No current owner-authorized location snapshot is available" },
          { status: 404, headers: noStore },
        )
      : Response.json(
          { ok: true, watchId: latest.watchId, snapshot: latest.snapshot },
          { headers: noStore },
        );
  }
  if (
    (body?.action !== "replay" && body?.action !== "stop_location") ||
    typeof body.id !== "string"
  ) {
    return Response.json({ error: "Invalid operation" }, { status: 400 });
  }
  if (body.action === "stop_location") {
    const stopped = await runApp(
      stopIMessageLocationWatch({
        watchId: body.id,
        ownerDeployment: actor.deploymentUrl,
      }),
    );
    return stopped
      ? Response.json({ ok: true }, { headers: noStore })
      : Response.json({ error: "Active location request not found" }, { status: 404 });
  }
  const replayed = await runApp(replayIMessageDeadLetter(body.id));
  if (replayed === null) {
    return Response.json(
      { error: "Dead letter not found or its retained body expired" },
      { status: 404 },
    );
  }
  await start(
    imessageIngressWorkflow,
    [replayed.conversationKey, randomUUID()],
    { deploymentId: "latest" },
  );
  return Response.json({ ok: true }, { status: 202, headers: noStore });
}
