import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram";
import { deliverToWebChatThread } from "../lib/web-thread-delivery";
import { claimDueReminders, completeReminder, releaseReminder, type ReminderRow } from "../lib/reminders-db";

// Dispatcher for application-managed reminders (see lib/reminders-db.ts).
// Fires every minute, claims due rows, and runs one proactive session per
// reminder. Delivery follows where the reminder was created: rows with a
// Telegram chat id reply into that DM; rows without one (web chat) run
// against our own eve channel and land as a new web chat thread.

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
    "Carry it out now and send Micky the result. He didn't just message you - this is proactive, so lead with what this is about.",
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
            if (reminder.chat_id !== null) {
              await receive(telegram, {
                message: reminderMessage(reminder),
                target: { chatId: reminder.chat_id },
                auth: appAuth,
              });
            } else {
              await deliverToWebChatThread(`Reminder: ${reminder.prompt}`, reminderMessage(reminder));
            }
            await completeReminder(reminder);
          } catch (error) {
            console.error(`Reminder ${reminder.id} delivery failed; releasing for retry.`, error);
            await releaseReminder(reminder.id);
          }
        })(),
      );
    }
  },
});
