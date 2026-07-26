import { defineDynamic, defineInstructions } from "eve/instructions";

const TELEGRAM_NOTE = `
This conversation is over Telegram. Write in plain text only: Telegram renders
markdown literally, so never use #, *, **, backticks, tables, or [links](url).
Short paragraphs and simple dashes are fine.
`.trim();

const IMESSAGE_NOTE = `
This conversation is over iMessage. Write like you text: plain text only (no
#, *, **, backticks, tables, or [links](url) - iMessage renders none of it),
short messages, and get to the point in the first line. Bare URLs are fine.
If an answer really needs structure, use short lines and simple dashes.
Photos and PDFs he texts you are attached to the message - look at them
directly. To send an image or file, use the send_attachment tool (for
sandbox files, share_file first, then pass the URL it returns) - it arrives
as a real attachment bubble, so don't paste the link as well. The react tool
puts a tapback on his message when a reaction beats a sentence; send_effect
sends a text with confetti/balloons/etc for moments that earn it; and
set_chat_background changes the conversation's wallpaper, only when he asks.
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

// Telegram authenticates with its webhook secret and iMessage with the
// router's pairing signature; everything else (web chat basic auth, local
// dev, the eve TUI) reaches the markdown-capable web surface.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const authenticator = ctx.session.auth.current?.authenticator ?? "";
      if (authenticator === "telegram-webhook") {
        return defineInstructions({ markdown: TELEGRAM_NOTE });
      }
      if (authenticator === "imessage-router") {
        return defineInstructions({ markdown: IMESSAGE_NOTE });
      }
      return defineInstructions({ markdown: WEB_NOTE });
    },
  },
});
