import { randomUUID } from "node:crypto";

import { runAdvancedIMessageEventSegment } from "@/agent/lib/effect/imessage/advanced-events";
import { isIMessageFeatureEnabled } from "@/agent/lib/imessage-feature-flags";
import { sleep } from "workflow";
import { start } from "workflow/api";

/**
 * Durable line pump. Each Node step owns the gRPC client for at most 220
 * seconds; Workflow survives between segments while Neon owns the lease and
 * contiguous cursor.
 */
export async function imessageAdvancedEventWorkflow(
  phone: string,
  workerId: string,
): Promise<void> {
  "use workflow";

  for (let segment = 0; segment < 360; segment += 1) {
    const result = await advancedEventSegmentStep(phone, workerId);
    if (result.status === "busy" || result.status === "disabled") return;
    await sleep("2s");
  }
  // Bound each Workflow history while keeping the line pump alive. The next
  // run gets a new worker identity and resumes from Neon's contiguous cursor.
  await restartAdvancedEventPumpStep(phone);
}

async function advancedEventSegmentStep(
  phone: string,
  workerId: string,
): Promise<
  | Awaited<ReturnType<typeof runAdvancedIMessageEventSegment>>
  | { readonly status: "disabled" }
> {
  "use step";
  if (!(await isIMessageFeatureEnabled("imessage_advanced_kit"))) {
    return { status: "disabled" };
  }
  return runAdvancedIMessageEventSegment(phone, workerId);
}

async function restartAdvancedEventPumpStep(phone: string): Promise<void> {
  "use step";
  await start(
    imessageAdvancedEventWorkflow,
    [phone, randomUUID()],
    { deploymentId: "latest" },
  );
}
