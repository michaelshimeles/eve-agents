import { LinkButton } from "@cloudflare/kumo";
import Image from "next/image";
import { AGENT_NAME, OWNER_NAME } from "@/lib/identity";

export default function Page() {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-slate-950 text-white">
      <Image
        src="/ruth-night-clouds.jpg"
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover object-center"
      />
      <div className="absolute inset-0 bg-slate-950/30" aria-hidden />

      <section className="relative flex min-h-dvh items-end px-6 pb-8 pt-20 sm:px-10 sm:pb-10 lg:px-12 lg:pb-12">
        <div className="max-w-3xl">
          <h1 className="text-balance text-4xl font-semibold leading-tight text-white sm:text-5xl">
            Meet {AGENT_NAME}
          </h1>
          <p className="mt-5 max-w-xl text-pretty text-base leading-7 text-white/75 sm:text-lg">
            {AGENT_NAME} is {OWNER_NAME}&rsquo;s personal agent, connecting to his tools, handling
            the busywork, and working alongside him—day or night.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <LinkButton
              href="/chat"
              variant="primary"
              className="bg-slate-950 text-white ring-white/20 hover:bg-slate-900"
            >
              Start a conversation
              <span aria-hidden>→</span>
            </LinkButton>
          </div>
        </div>
      </section>
    </main>
  );
}
