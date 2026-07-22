import { defineDynamic, defineInstructions } from "eve/instructions";

const TIMEZONE = "America/Toronto";

function currentTimeBlock(): string {
  const now = new Date().toLocaleString("en-CA", {
    timeZone: TIMEZONE,
    dateStyle: "full",
    timeStyle: "short",
  });
  return `Current date and time: ${now} (${TIMEZONE}).`;
}

// Kept in its own file on turn.started (cheap and synchronous) so the time
// stays fresh each turn while the slower memory profile resolves per session.
export default defineDynamic({
  events: {
    "turn.started": () => defineInstructions({ markdown: currentTimeBlock() }),
  },
});
