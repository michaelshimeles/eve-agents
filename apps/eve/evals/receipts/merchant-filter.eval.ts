import { defineEval } from "eve/evals";

export default defineEval({
  description: "A merchant-specific spending question uses a filtered receipt query.",
  tags: ["fast", "ci"],
  async test(t) {
    await t.send("What did I spend at Loblaws?");

    t.succeeded();
    t.calledTool("query_receipts", {
      input: { merchant: /loblaws/i },
    });
    t.notCalledTool("delete_receipt");
    t.notCalledTool("log_receipt");
    t.noFailedActions();
  },
});
