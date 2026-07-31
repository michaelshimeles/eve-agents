import { withAdvancedIMessageClient } from "@/agent/lib/effect/imessage/advanced";
import {
  acquireIMessageLocationWatchLease,
  finishIMessageLocationWatch,
  isIMessageLocationWatchActive,
  persistIMessageLocationSnapshot,
} from "@/agent/lib/effect/imessage/location";
import { runApp } from "@/agent/lib/effect/runtime";
import { isIMessageFeatureEnabled } from "@/agent/lib/imessage-feature-flags";
import { sleep } from "workflow";

const LOCATION_SEGMENT_MS = 220_000;

export async function imessageLocationWorkflow(
  watchId: string,
  address: string,
  expiresAt: string,
  workerId: string,
): Promise<void> {
  "use workflow";

  if (!(await acquireLocationLeaseStep(watchId, workerId))) return;
  try {
    while (Date.now() < Date.parse(expiresAt)) {
      if (!(await locationFeatureStep())) return;
      if (!(await acquireLocationLeaseStep(watchId, workerId))) return;
      await locationSegmentStep(watchId, address, expiresAt);
      await sleep("1s");
    }
  } finally {
    await finishLocationStep(watchId, workerId);
  }
}

async function acquireLocationLeaseStep(
  watchId: string,
  workerId: string,
): Promise<boolean> {
  "use step";
  return runApp(
    acquireIMessageLocationWatchLease({ watchId, workerId }),
  );
}

async function locationFeatureStep(): Promise<boolean> {
  "use step";
  return isIMessageFeatureEnabled("imessage_location");
}

async function locationSegmentStep(
  watchId: string,
  address: string,
  expiresAt: string,
): Promise<void> {
  "use step";

  const deadline = Math.min(
    Date.now() + LOCATION_SEGMENT_MS,
    Date.parse(expiresAt),
  );
  await withAdvancedIMessageClient(async (client) => {
    // Location watches have no catch-up log. Reconnect by fetching the latest
    // authoritative snapshot before opening the transient stream.
    const snapshot = await client.locations.get(address).catch(() => null);
    if (snapshot !== null) {
      await runApp(persistIMessageLocationSnapshot({ watchId, location: snapshot }));
    }
    const stream = client.locations.watch(address);
    const iterator = stream[Symbol.asyncIterator]();
    let next = iterator.next();
    try {
      while (Date.now() < deadline) {
        const remaining = Math.max(
          1,
          Math.min(5_000, deadline - Date.now()),
        );
        const update = await Promise.race([
          next,
          new Promise<"poll">((resolve) => {
            const timer = setTimeout(() => resolve("poll"), remaining);
            timer.unref?.();
          }),
        ]);
        if (update === "poll") {
          if (!(await runApp(isIMessageLocationWatchActive(watchId)))) break;
          continue;
        }
        if (update.done) break;
        await runApp(
          persistIMessageLocationSnapshot({
            watchId,
            location: update.value.location,
            sourceSequence: update.value.sourceSequence,
          }),
        );
        next = iterator.next();
      }
    } finally {
      await stream.close();
    }
  });
}

async function finishLocationStep(
  watchId: string,
  workerId: string,
): Promise<void> {
  "use step";
  await runApp(finishIMessageLocationWatch(watchId, workerId));
}
