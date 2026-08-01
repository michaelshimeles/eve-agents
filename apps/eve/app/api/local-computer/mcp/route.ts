import {
  authorizeLocalComputerAgent,
  awaitLocalComputerRelayResponse,
  enqueueLocalComputerRelay,
} from "@/agent/lib/effect/local-computer-relay";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  bearerToken,
  localComputerApiFailure,
} from "@/lib/local-computer-api";
import { Effect } from "effect";

// The helper caps local execution at 210 seconds and completion retries at
// 60 seconds. Keep transport slack on both sides of this waiter while staying
// below the function's 300-second maximum duration.
const REQUEST_TIMEOUT_MS = 285_000;
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
]);
const FORWARDED_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "mcp-session-id",
]);

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(
    [...request.headers.entries()].filter(([name]) =>
      FORWARDED_REQUEST_HEADERS.has(name.toLowerCase()),
    ),
  );
}

async function relay(request: Request): Promise<Response> {
  const token = bearerToken(request);
  if (token === null) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const method = request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD" ? null : await request.text();
  try {
    const result = await runApp(
      Effect.gen(function* () {
        const deviceId = yield* authorizeLocalComputerAgent(token);
        const requestId = yield* enqueueLocalComputerRelay(deviceId, {
          method,
          headers: requestHeaders(request),
          body,
        });
        return yield* awaitLocalComputerRelayResponse(
          requestId,
          REQUEST_TIMEOUT_MS,
        );
      }),
    );
    const headers = new Headers();
    for (const [name, value] of Object.entries(result.headers)) {
      if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) {
        headers.set(name, value);
      }
    }
    return new Response(result.body, { status: result.status, headers });
  } catch (error) {
    return localComputerApiFailure(error);
  }
}

export const GET = relay;
export const POST = relay;
export const DELETE = relay;
export const dynamic = "force-dynamic";
export const maxDuration = 300;
