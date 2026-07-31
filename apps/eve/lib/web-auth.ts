import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import {
  configuredClerkOwnerId,
  ownerAccessFor,
  WEB_OWNER_PRINCIPAL_ID,
} from "./owner-auth-policy";

export { WEB_OWNER_PRINCIPAL_ID };

export interface WebPrincipal {
  readonly principalId: typeof WEB_OWNER_PRINCIPAL_ID;
}

/**
 * Returns the stable owner data scope used by the single-owner web app.
 * Clerk authenticates transport access; persisted data deliberately keeps the
 * existing owner id so adding auth does not require a data migration.
 */
export function webRequestPrincipal(): WebPrincipal {
  return { principalId: WEB_OWNER_PRINCIPAL_ID };
}

async function currentOwnerAccess() {
  const { userId } = await auth();
  return ownerAccessFor(configuredClerkOwnerId(), userId);
}

/** Protect a server-rendered owner page and send signed-out users to Clerk. */
export async function requireOwnerPage(): Promise<void> {
  switch (await currentOwnerAccess()) {
    case "allowed":
      return;
    case "signed-out":
      redirect("/sign-in");
    case "forbidden":
      redirect("/unauthorized");
    case "unconfigured":
      throw new Error(
        "Owner authentication is not configured. Set CLERK_OWNER_USER_ID to your Clerk user id.",
      );
  }
}

function deniedResponse(access: Exclude<Awaited<ReturnType<typeof currentOwnerAccess>>, "allowed">) {
  const response =
    access === "unconfigured"
      ? Response.json(
          { error: "Owner authentication is not configured." },
          { status: 503 },
        )
      : access === "signed-out"
        ? Response.json(
            { error: "Sign in to continue.", authRequired: true },
            { status: 401 },
          )
        : Response.json(
            { error: "This account is not allowed to use Ruth." },
            { status: 403 },
          );
  response.headers.set("cache-control", "no-store");
  return response;
}

/** Require the configured Clerk owner for a browser-facing API route. */
export async function requireWebAuth(_request: Request): Promise<Response | null> {
  const access = await currentOwnerAccess();
  return access === "allowed" ? null : deniedResponse(access);
}

/** Allow either the Clerk owner or an existing route-specific admin token. */
export async function requireWebAuthOr(
  request: Request,
  alternate: () => Response | null,
): Promise<Response | null> {
  const denied = await requireWebAuth(request);
  if (denied === null) return null;
  return alternate() === null ? null : denied;
}
