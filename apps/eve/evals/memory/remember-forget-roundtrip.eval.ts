import { defineEval } from "eve/evals";

import { memoryStore } from "../../agent/lib/memory-store";
import { evalMarker } from "../shared";

function documentIdFrom(output: unknown): string | null {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return null;
  const documentId = (output as Record<string, unknown>).documentId;
  return typeof documentId === "string" && documentId.length > 0 ? documentId : null;
}

export default defineEval({
  description: "A requested memory write can be forgotten in the same session.",
  tags: ["write"],
  timeoutMs: 240_000,
  async test(t) {
    const marker = evalMarker("memory");
    let documentId: string | null = null;

    try {
      const saved = await t.send(
        `Remember this temporary eval fact now: Micky's temporary eval marker is ${marker}.`,
      );
      documentId = documentIdFrom(
        saved.toolCalls.find((call) => call.name === "remember")?.output,
      );

      await t.send("Now forget the temporary eval memory you just saved.");

      t.calledTool("remember", {
        input: {
          memory: (value) => typeof value === "string" && value.includes(marker),
        },
      });
      t.calledTool("forget");
      t.noFailedActions();
      t.succeeded();
    } finally {
      // Keep the real Supermemory account clean even if the model fails after
      // the write. A second delete is harmless when the tool already forgot it.
      if (documentId !== null) await memoryStore.delete(documentId);
    }
  },
});
