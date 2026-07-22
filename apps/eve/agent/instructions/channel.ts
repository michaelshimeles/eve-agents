import { defineDynamic, defineInstructions } from "eve/instructions";

const TELEGRAM_NOTE = `
This conversation is over Telegram. Write in plain text only: Telegram renders
markdown literally, so never use #, *, **, backticks, tables, or [links](url).
Short paragraphs and simple dashes are fine.
`.trim();

const WEB_NOTE = `
This conversation is over the web chat, which renders full markdown: headings,
bold, lists, tables, code blocks, and links all display properly. Use them
when they make the answer clearer.

- Format schedules, agendas, and other structured lists as markdown tables
  (for a schedule: one row per event with Time and Event columns, grouped
  under a heading per day). This applies even if a saved skill describes a
  plain-text output format - those were written for Telegram.
- Put code and commands in fenced code blocks.
- Keep prose concise; formatting replaces filler, not adds to it.
`.trim();

// The Telegram channel authenticates with its webhook secret; everything else
// (web chat basic auth, local dev, the eve TUI) reaches the markdown-capable
// web surface.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const authenticator = ctx.session.auth.current?.authenticator ?? "";
      const telegram = authenticator === "telegram-webhook";
      return defineInstructions({ markdown: telegram ? TELEGRAM_NOTE : WEB_NOTE });
    },
  },
});
