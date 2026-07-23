import { UpdateFlow } from "@/components/update-flow";

// Deep-linked from a deployed agent's manage-page banner when a newer
// template is available. Not linked from the builder home — create stays
// the only entry on `/`.

export default async function UpdatePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; update?: string }>;
}) {
  const params = await searchParams;
  // Prefer ?project=; accept legacy ?update= from older agent banners.
  const projectName = (params.project ?? params.update ?? "").trim();

  return (
    <main className="min-h-dvh">
      <header className="border-b border-gray-a4">
        <div className="mx-auto flex w-full max-w-5xl items-baseline gap-3 px-6 py-4">
          <a href="/" className="text-base font-semibold text-gray-12 hover:underline">
            eveclaw
          </a>
          <p className="text-sm text-gray-11">Update an existing agent onto the latest template.</p>
        </div>
      </header>
      <UpdateFlow initialProjectName={projectName} />
    </main>
  );
}
