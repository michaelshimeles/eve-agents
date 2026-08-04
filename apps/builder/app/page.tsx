import { BuilderWizard } from "@/components/wizard";

// Legacy `?update=<project>` deep links are redirected to /update by a
// config-level redirect, which keeps this route free of request data so it
// prerenders and navigations to it are instant.
export default function HomePage() {
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
