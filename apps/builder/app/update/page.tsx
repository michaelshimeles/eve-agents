import Link from "next/link";
import { Suspense } from "react";

import { UpdateFlow } from "@/components/update-flow";

// Deep-linked from a deployed agent's manage-page banner when a newer
// template is available. Not linked from the builder home — create stays
// the only entry on `/`.

// searchParams is read here rather than in the page so the header and layout
// prerender into the route's loading shell; the flow streams in once the
// request's query string is known.
async function UpdateFlowFromParams({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; update?: string }>;
}) {
  const params = await searchParams;
  // Prefer ?project=; accept legacy ?update= from older agent banners.
  const projectName = (params.project ?? params.update ?? "").trim();

  return <UpdateFlow initialProjectName={projectName} />;
}

export default function UpdatePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; update?: string }>;
}) {
  return (
    <main className="min-h-dvh">
      <header className="border-b border-gray-a4">
        <div className="mx-auto flex w-full max-w-5xl items-baseline gap-3 px-6 py-4">
          <Link href="/" className="text-base font-semibold text-gray-12 hover:underline">
            eveclaw
          </Link>
          <p className="text-sm text-gray-11">Update an existing agent onto the latest template.</p>
        </div>
      </header>
      <Suspense fallback={<UpdateFlowFallback />}>
        <UpdateFlowFromParams searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

function UpdateFlowFallback() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="h-40 animate-pulse rounded-lg bg-gray-a3" />
    </div>
  );
}
