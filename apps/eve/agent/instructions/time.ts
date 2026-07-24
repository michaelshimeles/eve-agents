import { defineDynamic, defineInstructions } from "eve/instructions";

const TIMEZONE = "America/Toronto";

// Deliberately hour-granular: this fragment lands in the system prompt, and
// Anthropic-style prompt caching invalidates system + conversation whenever
// any system byte changes. A minute-precision clock here busted the whole
// prompt cache on nearly every turn (measured: 0 cache-read tokens across a
// minute boundary, full re-ingest). Hour granularity caps that at one miss
// per hour; the exact minute comes from the client context or `date`.
function currentTimeBlock(): string {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA", { timeZone: TIMEZONE, dateStyle: "full" });
  const hour = now.toLocaleTimeString("en-CA", { timeZone: TIMEZONE, hour: "numeric" });
  return [
    `Current date: ${date}, around ${hour} (${TIMEZONE}).`,
    "When you need the exact minute (reminder times, countdowns), use the",
    "clientTime in the latest client context if present, or run `date` in bash.",
  ].join(" ");
}

// Still resolved on turn.started so long-lived sessions stay fresh; the
// coarse granularity is what keeps it prompt-cache friendly.
export default defineDynamic({
  events: {
    "turn.started": () => defineInstructions({ markdown: currentTimeBlock() }),
  },
});
