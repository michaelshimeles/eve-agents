import { defineEval } from "eve/evals";

const PHRASE = "cobalt-tulip-731";

export default defineEval({
  description: "Ruth recalls in-session context without writing long-term memory.",
  tags: ["ci"],
  timeoutMs: 180_000,
  async test(t) {
    await t.send(
      `For this conversation only, remember the code phrase "${PHRASE}". Do not save it to long-term memory.`,
    );
    await t.send("What was the code phrase I gave you?");

    t.succeeded();
    t.messageIncludes(PHRASE);
    t.notCalledTool("remember");
  },
});
