import { ClerkProvider, SignIn } from "@clerk/nextjs";
import Image from "next/image";

import { AGENT_NAME } from "@/lib/identity";

export default function SignInPage() {
  return (
    <ClerkProvider signInUrl="/sign-in" signInFallbackRedirectUrl="/">
      <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-slate-950 px-6 py-12 text-white">
        <Image
          src="/ruth-night-clouds.jpg"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-center"
        />
        <div className="absolute inset-0 bg-slate-950/55" aria-hidden />
        <section className="relative flex w-full max-w-md flex-col items-center gap-6">
          <div className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight">Sign in to {AGENT_NAME}</h1>
            <p className="mt-2 text-sm text-white/65">This assistant is private to its owner.</p>
          </div>
          <SignIn
            routing="path"
            path="/sign-in"
            fallbackRedirectUrl="/"
            appearance={{
              elements: {
                rootBox: "w-full",
                cardBox: "w-full shadow-2xl",
                footerAction: "hidden",
              },
            }}
          />
        </section>
      </main>
    </ClerkProvider>
  );
}
