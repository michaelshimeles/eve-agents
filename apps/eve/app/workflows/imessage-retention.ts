import { randomUUID } from "node:crypto";

import {
  acquireIMessageProviderLease,
  cleanupIMessageRetention,
  releaseIMessageProviderLease,
  renewIMessageProviderLease,
} from "@/agent/lib/effect/imessage/store";
import { cleanupIMessageLocationRetention } from "@/agent/lib/effect/imessage/location";
import { cleanupIMessagePollRetention } from "@/agent/lib/effect/imessage/polls";
import { cleanupSafeGroupMemory } from "@/agent/lib/effect/imessage/group-runtime";
import { runApp } from "@/agent/lib/effect/runtime";
import { sleep } from "workflow";
import { start } from "workflow/api";

const MAINTENANCE_PHONE = "system";
const MAINTENANCE_STREAM = "imessage-retention";
const LEASE_SECONDS = 65 * 60;

/**
 * Hourly retention enforcement. The first verified Photon webhook wakes this
 * singleton; Neon owns the lease, Workflow owns the durable sleeps, and each
 * 24-hour history hands off to a fresh run.
 */
export async function imessageRetentionWorkflow(workerId: string): Promise<void> {
  "use workflow";

  if (!(await acquireMaintenanceLeaseStep(workerId))) return;
  try {
    for (let hour = 0; hour < 24; hour += 1) {
      await cleanupRetentionStep();
      await sleep("1h");
      if (!(await renewMaintenanceLeaseStep(workerId))) return;
    }
  } finally {
    await releaseMaintenanceLeaseStep(workerId);
  }
  await restartMaintenanceStep();
}

async function acquireMaintenanceLeaseStep(workerId: string): Promise<boolean> {
  "use step";
  const lease = await runApp(
    acquireIMessageProviderLease({
      phone: MAINTENANCE_PHONE,
      eventStream: MAINTENANCE_STREAM,
      workerId,
      leaseSeconds: LEASE_SECONDS,
    }),
  );
  return lease !== null;
}

async function renewMaintenanceLeaseStep(workerId: string): Promise<boolean> {
  "use step";
  return runApp(
    renewIMessageProviderLease({
      phone: MAINTENANCE_PHONE,
      eventStream: MAINTENANCE_STREAM,
      workerId,
      leaseSeconds: LEASE_SECONDS,
    }),
  );
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

async function releaseMaintenanceLeaseStep(workerId: string): Promise<void> {
  "use step";
  await runApp(
    releaseIMessageProviderLease({
      phone: MAINTENANCE_PHONE,
      eventStream: MAINTENANCE_STREAM,
      workerId,
    }),
  );
}

async function restartMaintenanceStep(): Promise<void> {
  "use step";
  await start(
    imessageRetentionWorkflow,
    [randomUUID()],
    { deploymentId: "latest" },
  );
}
