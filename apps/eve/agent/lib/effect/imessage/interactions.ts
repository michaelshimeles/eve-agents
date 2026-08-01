import { timingSafeEqual } from "node:crypto";

import { Effect } from "effect";

import {
  consumeIMessageInteraction,
  createIMessageInteraction,
  readIMessageInteraction,
  readIMessageInteractionForAuthorization,
} from "./store";
import { fetchValidatedDeployment } from "./security";

export {
  consumeIMessageInteraction,
  createIMessageInteraction,
  readIMessageInteraction,
  readIMessageInteractionForAuthorization,
};

export function ownerActionAuthenticated(value: string | null): boolean {
  const expected = process.env.IMESSAGE_OWNER_ACTION_SECRET?.trim() ?? "";
  const supplied = value?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return (
    expected.length >= 32 &&
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

export function resumeIMessageInteraction(input: {
  readonly deploymentUrl: string;
  readonly sessionId: string;
  readonly continuationToken: string;
  readonly requestId: string;
  readonly optionId?: string;
  readonly value?: string;
}): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetchValidatedDeployment(
        input.deploymentUrl,
        `/eve/v1/session/${encodeURIComponent(input.sessionId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            continuationToken: input.continuationToken,
            inputResponses: [
              {
                requestId: input.requestId,
                ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
                ...(input.value === undefined ? {} : { value: input.value }),
              },
            ],
          }),
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        },
      );
      return response.ok;
    },
    catch: () => false,
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}
