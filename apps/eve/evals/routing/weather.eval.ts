import { defineEval } from "eve/evals";

export default defineEval({
  description: "A weather question routes to get_weather exactly once.",
  tags: ["fast", "ci"],
  async test(t) {
    await t.send("What is the weather in Toronto right now?");

    t.succeeded();
    t.calledTool("get_weather", {
      input: { city: /toronto/i },
      count: 1,
    });
    t.noFailedActions();
    t.maxToolCalls(2);
    t.messageIncludes(/toronto/i).soft();
  },
});
