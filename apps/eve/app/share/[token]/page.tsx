import { notFound } from "next/navigation";

import { resolveArtifactShare } from "@/agent/lib/effect/artifacts";
import { runApp } from "@/agent/lib/effect/runtime";
import { SharedArtifact } from "@/components/shared-artifact";

export const dynamic = "force-dynamic";

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  try {
    const shared = await runApp(resolveArtifactShare(token));
    return (
      <SharedArtifact
        artifact={shared.artifact}
        version={shared.version}
        token={token}
      />
    );
  } catch {
    notFound();
  }
}
