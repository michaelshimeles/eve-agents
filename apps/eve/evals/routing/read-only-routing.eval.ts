import { defineEval } from "eve/evals";

const cases = [
  {
    description: "Spending summaries use the read-only aggregate tool.",
    prompt: "Give me a summary of my spending by category.",
    target: "spending_summary",
    destructive: ["log_receipt", "delete_receipt"],
  },
  {
    description: "Reminder inventory uses the read-only list tool.",
    prompt: "List all my active reminders and scheduled tasks.",
    target: "list_reminders",
    destructive: ["create_reminder", "cancel_reminder"],
  },
  {
    description: "Memory inventory uses the read-only list tool.",
    prompt: "List every long-term memory you currently have saved about me.",
    target: "list_memories",
    destructive: ["remember", "forget"],
  },
  {
    description: "Mailbox inventory uses the read-only list tool.",
    prompt: "Show me the latest conversations in your own email inbox.",
    target: "list_emails",
    destructive: ["send_email", "reply_to_email", "label_email"],
  },
] as const;

export default cases.map((evalCase) =>
  defineEval({
    description: evalCase.description,
    tags: ["ci", "routing"],
    async test(t) {
      await t.send(evalCase.prompt);

      t.succeeded();
      t.calledTool(evalCase.target);
      for (const tool of evalCase.destructive) t.notCalledTool(tool);
      t.noFailedActions();
    },
  }),
);
