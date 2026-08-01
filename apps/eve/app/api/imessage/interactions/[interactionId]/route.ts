import { randomUUID } from "node:crypto";

import {
  consumeIMessageInteraction,
  ownerActionAuthenticated,
  readIMessageInteraction,
} from "@/agent/lib/effect/imessage/interactions";
import { runApp } from "@/agent/lib/effect/runtime";
import { imessageInteractionResumeWorkflow } from "@/app/workflows/imessage-interaction-resume";
import { start } from "workflow/api";

function tokenFrom(request: Request, body?: Record<string, unknown>): string {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const query = new URL(request.url).searchParams.get("token");
  if (query !== null) return query;
  return typeof body?.token === "string" ? body.token : "";
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

const privateHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function rendererState(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const {
    deploymentUrl: _deploymentUrl,
    sessionId: _sessionId,
    continuationToken: _continuationToken,
    commandId: _commandId,
    operation: _operation,
    ...publicState
  } = value as Record<string, unknown>;
  return publicState;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ interactionId: string }> },
): Promise<Response> {
  const { interactionId } = await context.params;
  const interaction = await runApp(
    readIMessageInteraction({
      interactionId,
      token: tokenFrom(request),
    }),
  );
  if (interaction === null) {
    return Response.json({ error: "Interaction not found or expired" }, {
      status: 404,
      headers: privateHeaders,
    });
  }
  return Response.json(
    {
      interactionId: interaction.interactionId,
      kind: interaction.kind,
      stateVersion: interaction.stateVersion,
      status: interaction.status,
      sensitive: interaction.sensitive,
      // Continuation/session credentials are server-only. Possession of the
      // Mini App capability can render a card but can never call Eve directly.
      state: rendererState(interaction.state),
      expiresAt: interaction.expiresAt,
    },
    { headers: privateHeaders },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ interactionId: string }> },
): Promise<Response> {
  if (!sameOrigin(request)) {
    return Response.json({ error: "Cross-origin action refused" }, {
      status: 403,
      headers: privateHeaders,
    });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) {
    return Response.json({ error: "Invalid action" }, {
      status: 400,
      headers: privateHeaders,
    });
  }
  const { interactionId } = await context.params;
  const stateVersion =
    typeof body.stateVersion === "number" && Number.isInteger(body.stateVersion)
      ? body.stateVersion
      : 0;
  const result = await runApp(
    consumeIMessageInteraction({
      interactionId,
      token: tokenFrom(request, body),
      stateVersion,
      result: body.result ?? null,
      ownerAuthenticated: ownerActionAuthenticated(
        request.headers.get("x-ruth-owner-authorization"),
      ),
    }),
  );
  if (result.status === "rejected") {
    return Response.json({ error: result.reason }, {
      status: result.reason.includes("authenticated owner") ? 401 : 409,
      headers: privateHeaders,
    });
  }

  await start(
    imessageInteractionResumeWorkflow,
    [result.interaction.interactionId, randomUUID()],
    { deploymentId: "latest" },
  );
  return Response.json(
    { ok: true, resumed: false, status: "selected" },
    { status: 202, headers: privateHeaders },
  );
}
