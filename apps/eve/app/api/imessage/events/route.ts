import { randomUUID, timingSafeEqual } from "node:crypto";

import { start } from "workflow/api";

import {
  advancedIMessageConfigured,
  advancedIMessageLine,
  advancedIMessageSupportsPhone,
} from "@/agent/lib/effect/imessage/advanced";
import { imessageAdvancedEventWorkflow } from "@/app/workflows/imessage-events";

function secretMatches(value: string | null): boolean {
  const expected = process.env.CRON_SECRET?.trim() ?? "";
  const supplied = value?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return expected.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

async function startPump(
  request: Request,
  requestedPhone?: string,
): Promise<Response> {
  if (!secretMatches(request.headers.get("authorization"))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!advancedIMessageConfigured()) {
    return Response.json(
      { ok: false, reason: "Photon Advanced iMessage Kit is not configured" },
      { status: 409 },
    );
  }
  const phone =
    requestedPhone !== undefined && requestedPhone.trim().length > 0
      ? requestedPhone.trim()
      : advancedIMessageLine() ?? "";
  if (phone.length === 0) {
    return Response.json({ error: "phone is required" }, { status: 400 });
  }
  if (!advancedIMessageSupportsPhone(phone)) {
    return Response.json(
      { error: "phone is not bound to these Advanced Kit credentials" },
      { status: 403 },
    );
  }
  const run = await start(
    imessageAdvancedEventWorkflow,
    [phone, randomUUID()],
    { deploymentId: "latest" },
  );
  return Response.json({ ok: true, runId: run.runId }, { status: 202 });
}

/** Vercel Cron watchdog. The line lease makes duplicate starts harmless. */
export async function GET(request: Request): Promise<Response> {
  return startPump(request);
}

/** Owner/operator wake-up with an optional explicit line assertion. */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { phone?: unknown }
    | null;
  return startPump(
    request,
    typeof body?.phone === "string" ? body.phone : undefined,
  );
}
