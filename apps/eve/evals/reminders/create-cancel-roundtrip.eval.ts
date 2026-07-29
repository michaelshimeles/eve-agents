import { defineEval } from "eve/evals";

import { cancelReminder } from "../../agent/lib/reminders-db";
import { evalMarker } from "../shared";

function reminderIdFrom(output: unknown): number | null {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return null;
  const id = (output as Record<string, unknown>).id;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

export default defineEval({
  description: "A reminder can be created and cancelled without leaving an eval artifact.",
  tags: ["write"],
  timeoutMs: 240_000,
  async test(t) {
    const marker = evalMarker("reminder");
    const fireAt = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();
    let reminderId: number | null = null;

    try {
      const created = await t.send(
        `Create a one-off reminder for ${fireAt}. Its exact prompt must be: "Eval artifact ${marker} — if this fires, do nothing."`,
      );
      reminderId = reminderIdFrom(
        created.toolCalls.find((call) => call.name === "create_reminder")?.output,
      );

      await t.send("Cancel the eval reminder you just created.");

      t.calledTool("create_reminder", {
        input: { prompt: /eval artifact/i },
        count: 1,
      });
      t.calledTool("cancel_reminder");
      t.noFailedActions();
      t.succeeded();
    } finally {
      // Direct cleanup is a backstop for assertion/model failures after the
      // write. cancelReminder returns null when the tool already cleaned up.
      if (reminderId !== null) await cancelReminder(reminderId);
    }
  },
});
