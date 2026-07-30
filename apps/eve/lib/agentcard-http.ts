import { Cause } from "effect";

import { AgentcardError, describeAgentcardError } from "@/agent/lib/effect/agentcard";

/** Maps typed failures to the Connect API error contract the panel can act on. */
export function agentcardFailure(cause: Cause.Cause<unknown>): Response {
  const error = Cause.squash(cause);
  if (error instanceof AgentcardError) {
    const code =
      error.code ??
      (error.reason === "consent_required"
        ? "consent_required"
        : error.reason === "authorization_state"
          ? "invalid_connect_attempt"
          : error.reason);
    const status =
      error.reason === "no_database" || error.reason === "not_configured"
        ? 503
        : code === "invalid_code"
          ? 401
          : code === "invalid_connect_attempt"
            ? 409
            : error.reason === "consent_required"
              ? 400
              : error.reason === "provider" && error.status === 401
                ? 502
                : error.reason === "provider" &&
                    error.status !== undefined &&
                    error.status < 500
                  ? error.status
                  : 502;
    return Response.json(
      {
        error: {
          code,
          message: error.detail ?? describeAgentcardError(error),
          ...(error.docs === undefined ? {} : { docs: error.docs }),
        },
        ...(code === "invalid_code" ? { retryCode: true } : {}),
        ...(code === "invalid_connect_attempt" ? { restart: true } : {}),
      },
      { status },
    );
  }
  return Response.json(
    {
      error: {
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      },
    },
    { status: 500 },
  );
}
