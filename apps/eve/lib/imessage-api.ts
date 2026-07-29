import { Cause, type Effect, Exit } from "effect";
import { isSchemaError } from "effect/SchemaError";

import { DatabaseError, describeDatabaseError } from "@/agent/lib/effect/db";
import { IMessageError, describeIMessageError } from "@/agent/lib/effect/imessage";
import { type AppServices, runtime } from "@/agent/lib/effect/runtime";

// Boundary for the /api/imessage/* route handlers: run the Effect program,
// render success as JSON, and map the typed failure onto the HTTP status the
// caller (a pairing deployment, the panel, or a probe) should see.

function statusFor(failure: unknown): number {
  if (failure instanceof IMessageError) {
    if (failure.status !== undefined) return failure.status;
    switch (failure.reason) {
      case "not_configured":
        // Not a router: the endpoint effectively does not exist here.
        return 404;
      case "no_database":
        return 503;
      case "validation":
        return 400;
      case "pairing":
        return 400;
      case "not_paired":
        return 409;
      case "router":
      case "spectrum":
        return 502;
    }
  }
  if (failure instanceof DatabaseError) return 500;
  return 500;
}

function describe(failure: unknown): string {
  if (failure instanceof IMessageError) return describeIMessageError(failure);
  if (failure instanceof DatabaseError) return describeDatabaseError(failure);
  if (isSchemaError(failure)) return `Invalid data: ${failure.message}`;
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Runs `program` and answers with `body(result)` as JSON, or with
 * `{ error }` and a reason-derived status on failure.
 */
export async function respondWith<A, E>(
  program: Effect.Effect<A, E, AppServices>,
  body: (result: A) => unknown = () => ({ ok: true }),
): Promise<Response> {
  const exit = await runtime.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return Response.json(body(exit.value));
  const failure = Cause.squash(exit.cause);
  return Response.json({ error: describe(failure) }, { status: statusFor(failure) });
}

/**
 * Like `respondWith`, but the success arm builds the whole Response —
 * for routes whose payload is not JSON (attachment bytes).
 */
export async function respondWithRaw<A, E>(
  program: Effect.Effect<A, E, AppServices>,
  render: (result: A) => Response,
): Promise<Response> {
  const exit = await runtime.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return render(exit.value);
  const failure = Cause.squash(exit.cause);
  return Response.json({ error: describe(failure) }, { status: statusFor(failure) });
}

/** The bearer token on a router API request, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1].trim();
}

/** One string field out of an untyped JSON body. */
export function stringField(body: unknown, name: string): string {
  if (body !== null && typeof body === "object") {
    const value = (body as Record<string, unknown>)[name];
    if (typeof value === "string") return value;
  }
  return "";
}
