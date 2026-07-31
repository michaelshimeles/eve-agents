import {
  authorizeLocalComputerDevice,
  completeLocalComputerRelay,
  pollLocalComputerRelay,
} from "@/agent/lib/effect/local-computer-relay";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  bearerToken,
  localComputerApiFailure,
  stringField,
  stringRecord,
} from "@/lib/local-computer-api";
import { Effect } from "effect";

export async function POST(request: Request): Promise<Response> {
  const token = bearerToken(request);
  if (token === null) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const action = stringField(body, "action", 20);
  try {
    if (action === "poll") {
      const relayRequest = await runApp(
        Effect.gen(function* () {
          const deviceId = yield* authorizeLocalComputerDevice(token);
          return yield* pollLocalComputerRelay(deviceId);
        }),
      );
      return relayRequest === null
        ? new Response(null, { status: 204 })
        : Response.json({ request: relayRequest });
    }
    if (action === "complete") {
      const requestId = stringField(body, "requestId", 100);
      const responseValue =
        body !== null && typeof body === "object"
          ? (body as { response?: unknown }).response
          : null;
      const responseObject =
        responseValue !== null && typeof responseValue === "object"
          ? (responseValue as Record<string, unknown>)
          : {};
      const status = responseObject.status;
      const responseBody = responseObject.body;
      if (
        requestId.length === 0 ||
        typeof status !== "number" ||
        typeof responseBody !== "string"
      ) {
        return Response.json({ error: "Invalid relay completion." }, { status: 400 });
      }
      await runApp(
        Effect.gen(function* () {
          const deviceId = yield* authorizeLocalComputerDevice(token);
          yield* completeLocalComputerRelay(deviceId, requestId, {
            status,
            headers: stringRecord(responseObject.headers),
            body: responseBody,
          });
        }),
      );
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "Unknown relay action." }, { status: 400 });
  } catch (error) {
    return localComputerApiFailure(error);
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;
