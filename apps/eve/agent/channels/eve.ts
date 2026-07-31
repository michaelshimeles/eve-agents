import {
  type AuthFn,
  ForbiddenError,
  localDev,
  UnauthenticatedError,
  vercelOidc,
} from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

import { authenticateClerkOwnerRequest } from "../lib/effect/clerk-owner-auth";
import { runApp } from "../lib/effect/runtime";
import { WEB_OWNER_PRINCIPAL_ID } from "../../lib/owner-auth-policy";

const clerkOwner: AuthFn<Request> = async (request) => {
  let access;
  try {
    access = await runApp(authenticateClerkOwnerRequest(request));
  } catch {
    throw new UnauthenticatedError({
      code: "clerk_auth_unavailable",
      message: "Sign-in verification is temporarily unavailable. Try again shortly.",
    });
  }

  switch (access.kind) {
    case "allowed":
      return {
        attributes: { clerkUserId: access.userId },
        authenticator: "clerk",
        issuer: "clerk",
        principalId: WEB_OWNER_PRINCIPAL_ID,
        principalType: "user",
      };
    case "forbidden":
      throw new ForbiddenError({
        code: "owner_required",
        message: "This account is not allowed to use Ruth.",
      });
    case "signed-out":
    case "unconfigured":
      return null;
  }
};

export default eveChannel({
  auth: [
    // Browser calls carry the Clerk session cookie and resolve to Ruth's one
    // stable owner principal. Every other Clerk account is rejected.
    clerkOwner,
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
  ],
});
