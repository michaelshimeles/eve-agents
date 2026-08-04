import { type NextRequest, NextResponse } from "next/server";

// Older agent banners deep-linked to /?update=<project>. Redirecting here
// instead of in the page keeps `/` free of searchParams access, which Cache
// Components needs to prerender it; and unlike a `redirects()` rule, this
// drops the legacy param instead of carrying it into the destination URL.
export function proxy(request: NextRequest): NextResponse {
  const project = request.nextUrl.searchParams.get("update")?.trim();
  if (project === undefined || project.length === 0) return NextResponse.next();

  const destination = new URL("/update", request.nextUrl);
  destination.search = "";
  destination.searchParams.set("project", project);
  return NextResponse.redirect(destination);
}

export const config = { matcher: "/" };
