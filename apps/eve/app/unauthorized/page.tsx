import { ClerkProvider, SignOutButton } from "@clerk/nextjs";

import { AGENT_NAME } from "@/lib/identity";

export default function UnauthorizedPage() {
  return (
    <ClerkProvider signInUrl="/sign-in">
      <main className="flex min-h-dvh items-center justify-center bg-slate-950 px-6 text-white">
        <section className="max-w-md text-center">
          <h1 className="text-3xl font-semibold tracking-tight">This isn&apos;t the owner account</h1>
          <p className="mt-3 text-sm leading-6 text-white/65">
            {AGENT_NAME} only accepts the one Clerk account configured by its owner.
          </p>
          <SignOutButton redirectUrl="/sign-in">
            <button
              type="button"
              className="mt-6 rounded-lg border border-white/15 bg-white px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-white/90"
            >
              Sign out and try again
            </button>
          </SignOutButton>
        </section>
      </main>
    </ClerkProvider>
  );
}
