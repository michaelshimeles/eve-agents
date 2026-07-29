import { defineEval } from "eve/evals";

export default defineEval({
  description: "Ruth leads with a concise answer to a simple factual question.",
  tags: ["ci", "judge"],
  async test(t) {
    await t.send("What year did the Berlin Wall fall?");

    t.succeeded();
    t.usedNoTools();
    t.messageIncludes(/1989/);
    t.judge.autoevals
      .closedQA("The response leads with the answer, is concise, and contains no filler.")
      .atLeast(0.7);
  },
});
