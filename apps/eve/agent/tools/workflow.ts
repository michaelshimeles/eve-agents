import { experimental_workflow } from "eve/tools";

// Enables the root-only `Workflow` tool: the model writes a small JS program
// (run in a QuickJS sandbox) that coordinates `agent` subagent calls —
// fan-out over a list, feed one result into the next, map-reduce — as one
// durable step. The cap keeps a runaway fan-out from spawning dozens of
// child sessions.
export default experimental_workflow({ maxSubagents: 10 });
