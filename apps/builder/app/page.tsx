import { Suspense } from "react";

import { BuilderHome } from "@/components/builder-home";

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
      {/* Suspense boundary for useSearchParams (?update=<project> deep links). */}
      <Suspense fallback={null}>
        <BuilderHome />
      </Suspense>
    </main>
  );
}
