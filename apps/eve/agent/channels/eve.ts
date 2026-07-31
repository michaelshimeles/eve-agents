import { ForbiddenError, localDev, none, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

import {
  anonymousEveCallerHash,
  checkAnonymousEveRateLimit,
  isAnonymousEveMessageRequest,
} from "../lib/effect/anonymous-eve-rate-limit";
import { runApp } from "../lib/effect/runtime";

const acceptAnonymous = none<Request>();

async function rateLimitedAnonymous(request: Request) {
  if (isAnonymousEveMessageRequest(request)) {
    let decision;
    try {
      decision = await runApp(checkAnonymousEveRateLimit(anonymousEveCallerHash(request)));
    } catch {
      throw new ForbiddenError({
        code: "anonymous_rate_limit_unavailable",
        message: "Anonymous chat is temporarily unavailable. Try again shortly.",
      });
    }
    if (!decision.allowed) {
      throw new ForbiddenError({
        code: "anonymous_rate_limit_exceeded",
        message: `Anonymous chat request limit reached. Try again in ${decision.retryAfterSeconds} seconds.`,
      });
    }
  }
  return acceptAnonymous(request);
}

export default eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // Web chat stays open, but production-anonymous model calls share a
    // durable per-caller budget across every resettable Eve session.
    rateLimitedAnonymous,
  ],
});
