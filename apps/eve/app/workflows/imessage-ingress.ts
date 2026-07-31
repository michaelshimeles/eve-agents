import {
  acquireIMessageWorkerLease,
  claimIMessageIngress,
  completeIMessageIngress,
  cleanupIMessageRetention,
  failIMessageIngress,
  releaseIMessageWorkerLease,
} from "@/agent/lib/effect/imessage/store";
import { cleanupIMessageLocationRetention } from "@/agent/lib/effect/imessage/location";
import { cleanupIMessagePollRetention } from "@/agent/lib/effect/imessage/polls";
import { cleanupSafeGroupMemory } from "@/agent/lib/effect/imessage/group-runtime";
import { processIMessageRouterDelivery } from "@/agent/lib/effect/imessage/router-delivery";
import { runApp } from "@/agent/lib/effect/runtime";
import { sleep } from "workflow";

const MAX_EVENTS_PER_RUN = 250;
const MAX_ATTEMPTS = 6;

export async function imessageIngressWorkflow(
  conversationKey: string,
  workerId: string,
): Promise<void> {
  "use workflow";

  if (!(await acquireLeaseStep(conversationKey, workerId))) return;
  try {
    let emptyPolls = 0;
    for (let index = 0; index < MAX_EVENTS_PER_RUN; index += 1) {
      const outcome = await processOneStep(conversationKey, workerId);
      if (outcome.kind === "processed") {
        emptyPolls = 0;
        continue;
      }
      if (outcome.kind === "retry") {
        await sleep(outcome.delayMs);
        continue;
      }
      emptyPolls += 1;
      if (emptyPolls >= 2) break;
      // Close the enqueue-vs-release race: a route that inserted while this
      // worker was finishing gets one more durable poll before the lease ends.
      await sleep("1s");
    }
  } finally {
    await releaseLeaseStep(conversationKey, workerId);
    await cleanupRetentionStep();
  }
}

async function acquireLeaseStep(
  conversationKey: string,
  workerId: string,
): Promise<boolean> {
  "use step";
  return runApp(acquireIMessageWorkerLease({ conversationKey, workerId }));
}

async function processOneStep(
  conversationKey: string,
  workerId: string,
): Promise<
  | { readonly kind: "empty" }
  | { readonly kind: "processed" }
  | { readonly kind: "retry"; readonly delayMs: number }
> {
  "use step";

  const renewed = await runApp(
    acquireIMessageWorkerLease({ conversationKey, workerId }),
  );
  if (!renewed) return { kind: "empty" };

  const claim = await runApp(
    claimIMessageIngress({ conversationKey, workerId }),
  );
  if (claim === null) return { kind: "empty" };

  try {
    await runApp(processIMessageRouterDelivery(claim.rawBody));
    await runApp(
      completeIMessageIngress({ id: claim.id, workerId }),
    );
  } catch (error) {
    const terminal = claim.attempts >= MAX_ATTEMPTS;
    const delayMs = Math.min(60_000, 500 * 2 ** Math.max(0, claim.attempts - 1));
    await runApp(
      failIMessageIngress({
        id: claim.id,
        workerId,
        errorCode:
          error instanceof Error
            ? error.name.slice(0, 120)
            : "IMESSAGE_FORWARD_FAILED",
        retryAt: terminal ? null : new Date(Date.now() + delayMs),
      }),
    );
    // Preserve per-conversation order: do not step past a failed event.
    return terminal ? { kind: "empty" } : { kind: "retry", delayMs };
  }
  return { kind: "processed" };
}

async function releaseLeaseStep(
  conversationKey: string,
  workerId: string,
): Promise<void> {
  "use step";
  await runApp(releaseIMessageWorkerLease({ conversationKey, workerId }));
}

async function cleanupRetentionStep(): Promise<void> {
  "use step";
  await Promise.all([
    runApp(cleanupIMessageRetention()),
    runApp(cleanupIMessagePollRetention()),
    runApp(cleanupIMessageLocationRetention()),
    runApp(cleanupSafeGroupMemory()),
  ]);
}
