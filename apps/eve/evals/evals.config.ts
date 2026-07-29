import { defineEvalConfig } from "eve/evals";
import { Braintrust } from "eve/evals/reporters";

export default defineEvalConfig({
  // Cheap and capable, while staying on a different family tier than Ruth.
  // With no Gateway credentials, judge-backed evals skip visibly.
  judge: { model: "anthropic/claude-haiku-4.5" },
  // A bare local run never tries to initialize a remote reporter.
  reporters: process.env.BRAINTRUST_API_KEY ? [Braintrust({ projectName: "ruth" })] : [],
  // These evals share real hosted backends. Keep concurrency low so runs do
  // not interleave state or create avoidable rate-limit flakes.
  maxConcurrency: 2,
  timeoutMs: 120_000,
});
