import { defineEval } from "eve/evals";

export default defineEval({
  description: "Ruth can answer a minimal turn without reaching for a tool.",
  tags: ["fast", "ci"],
  async test(t) {
    await t.send('Reply with the single word "pong".');

    t.succeeded();
    t.usedNoTools();
    t.messageIncludes(/pong/i);
  },
});
