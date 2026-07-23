import { redirect } from "next/navigation";

import { BuilderWizard } from "@/components/wizard";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ update?: string }>;
}) {
  const params = await searchParams;
  // Older agent banners deep-linked here with ?update=<project>. Send them
  // to the dedicated update page.
  const legacy = params.update?.trim();
  if (legacy !== undefined && legacy.length > 0) {
    redirect(`/update?project=${encodeURIComponent(legacy)}`);
  }

  return (
    <main className="min-h-dvh">
      <header className="border-b border-gray-a4">
        <div className="mx-auto flex w-full max-w-5xl items-baseline gap-3 px-6 py-4">
          <h1 className="text-base font-semibold text-gray-12">eveclaw</h1>
          <p className="text-sm text-gray-11">
            Build your own Eve agent and deploy it to your Vercel account.
          </p>
        </div>
      </header>
      <BuilderWizard />
    </main>
  );
}
