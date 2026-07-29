import { defineEval } from "eve/evals";

export default defineEval({
  description: "Ordinary chitchat does not trigger a tool.",
  tags: ["fast", "ci"],
  async test(t) {
    await t.send("Good morning!");

    t.succeeded();
    t.usedNoTools();
  },
});
