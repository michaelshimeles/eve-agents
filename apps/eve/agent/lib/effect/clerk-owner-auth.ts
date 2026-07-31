import { createClerkClient } from "@clerk/backend";
import { Data, Effect } from "effect";

import { configuredClerkOwnerId, ownerAccessFor } from "@/lib/owner-auth-policy";

export type ClerkOwnerRequestAccess =
  | { readonly kind: "allowed"; readonly userId: string }
  | { readonly kind: "forbidden" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "unconfigured" };

export class ClerkOwnerAuthError extends Data.TaggedError("ClerkOwnerAuthError")<{
  readonly cause: unknown;
}> {}

function configuredClerkKeys(): { publishableKey: string; secretKey: string } | null {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!publishableKey || !secretKey) return null;
  return { publishableKey, secretKey };
}

/** Verify Clerk's session cookie on Eve's raw Request boundary. */
export function authenticateClerkOwnerRequest(
  request: Request,
): Effect.Effect<ClerkOwnerRequestAccess, ClerkOwnerAuthError> {
  const keys = configuredClerkKeys();
  const ownerId = configuredClerkOwnerId();
  if (keys === null || ownerId === null) {
    return Effect.succeed({ kind: "unconfigured" });
  }

  return Effect.tryPromise({
    try: async () => {
      const clerk = createClerkClient(keys);
      return clerk.authenticateRequest(request, {
        acceptsToken: "session_token",
        authorizedParties: [new URL(request.url).origin],
      });
    },
    catch: (cause) => new ClerkOwnerAuthError({ cause }),
  }).pipe(
    Effect.map((state): ClerkOwnerRequestAccess => {
      if (!state.isAuthenticated) return { kind: "signed-out" };
      const userId = state.toAuth().userId;
      const access = ownerAccessFor(ownerId, userId);
      if (access === "allowed") return { kind: "allowed", userId };
      return { kind: access };
    }),
  );
}
