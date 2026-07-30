import { defineSchedule } from "eve/schedules";

import agentphone from "../channels/agentphone";
import imessage from "../channels/imessage";
import slack from "../channels/slack";
import telegram from "../channels/telegram";
import { resolveDeliveryRoute } from "../lib/delivery";
import { notifyOwnerOverIMessage } from "../lib/effect/imessage";
import { runTool } from "../lib/effect/runtime";
import { ownerName } from "../lib/owner";
import { recordAutomationRun } from "../lib/runs-db";
import { deliverToWebChatThread } from "../lib/web-thread-delivery";
import { claimDueReminders, completeReminder, releaseReminder, type ReminderRow } from "../lib/reminders-db";

// Dispatcher for application-managed reminders (see lib/reminders-db.ts).
// Fires every minute, claims due rows, and runs one proactive session per
// reminder. Where the result lands is the owner's delivery preference
// (lib/delivery.ts): by default it follows where the reminder was created —
// rows with a Telegram chat id reply into that DM; rows without one (web
// chat) run against our own eve channel and land as a new web chat thread,
// also texted to a paired iMessage number so the result reaches the owner's
// phone. An explicit preference pins every reminder to that one place.

function reminderMessage(reminder: ReminderRow): string {
  const cadence =
    reminder.cron === null
      ? "a one-off reminder"
      : `a recurring task (cron "${reminder.cron}", ${reminder.timezone})`;
  return [
    `Scheduled ${cadence} you set earlier (id ${reminder.id}) just fired. Its instruction:`,
    "",
    reminder.prompt,
    "",
    `Carry it out now and send ${ownerName()} the result. They didn't just message you - this is proactive, so lead with what this is about.`,
  ].join("\n");
}

export default defineSchedule({
  cron: "* * * * *",
  async run({ receive, waitUntil, appAuth }) {
    const due = await claimDueReminders();

    for (const reminder of due) {
      waitUntil(
        (async () => {
          try {
            let threadId: string | undefined;
            const route = await resolveDeliveryRoute(reminder.chat_id);
            if (route.kind === "telegram") {
              await receive(telegram, {
                message: reminderMessage(reminder),
                target: { chatId: route.chatId },
                auth: appAuth,
              });
            } else if (route.kind === "imessage") {
              // The session runs in the owner's iMessage conversation, so a
              // reply text continues it.
              await receive(imessage, {
                message: reminderMessage(reminder),
                target: { handle: route.handle },
                auth: appAuth,
              });
            } else if (route.kind === "slack") {
              // The session runs in the owner's Slack DM, so a reply in that
              // thread continues it.
              await receive(slack, {
                message: reminderMessage(reminder),
                target: { channelId: route.channelId },
                auth: appAuth,
              });
            } else if (route.kind === "phone") {
              // The session runs in the owner's text thread, so a reply
              // continues it.
              await receive(agentphone, {
                message: reminderMessage(reminder),
                target: { target: route.target },
                auth: appAuth,
              });
            } else {
              const delivery = await deliverToWebChatThread(
                `Reminder: ${reminder.prompt}`,
                reminderMessage(reminder),
                "reminder",
              );
              threadId = delivery.threadId;
              // Best-effort, like the web push: the thread is already
              // persisted, so an iMessage failure must not release the
              // reminder — a retry would run the whole session again and
              // create a duplicate thread.
              if (route.mirror) {
                try {
                  await runTool(
                    notifyOwnerOverIMessage(delivery.reply ?? `Reminder fired: ${reminder.prompt}`),
                  );
                } catch (error) {
                  console.error(`Reminder ${reminder.id} iMessage notification failed.`, error);
                }
              }
            }
            await completeReminder(reminder);
            await recordAutomationRun({
              kind: "reminder",
              automationId: reminder.id,
              status: "ok",
              threadId,
            });
          } catch (error) {
            console.error(`Reminder ${reminder.id} delivery failed; releasing for retry.`, error);
            await releaseReminder(reminder.id);
            await recordAutomationRun({
              kind: "reminder",
              automationId: reminder.id,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            }).catch(() => undefined);
          }
        })(),
      );
    }
  },
});
