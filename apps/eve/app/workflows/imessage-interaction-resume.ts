import { randomUUID } from "node:crypto";

import { resumeIMessageInteraction } from "@/agent/lib/effect/imessage/interactions";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  claimIMessageInteractionResume,
  completeIMessageInteractionResume,
  releaseIMessageInteractionResume,
} from "@/agent/lib/effect/imessage/store";
import { sleep } from "workflow";
import { start } from "workflow/api";

type ResumeOutcome = "complete" | "retry" | "settled";

/**
 * Delivers a persisted interaction selection to the exact Eve request. The
 * interaction remains `selected` until the deployment confirms the resume, so
 * Workflow replay and deployment outages cannot consume a user's action.
 */
export async function imessageInteractionResumeWorkflow(
  interactionId: string,
  workerId: string,
): Promise<void> {
  "use workflow";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const outcome = await resumeInteractionStep(interactionId, workerId);
    if (outcome !== "retry") return;
    await sleep(`${Math.min(60, 2 ** Math.min(attempt, 6))}s`);
  }

  // Bound Workflow history while preserving the selected row as the durable
  // outbox. The successor obtains a fresh fenced lease and keeps trying until
  // the interaction succeeds or expires.
  await restartInteractionResumeStep(interactionId);
}

async function resumeInteractionStep(
  interactionId: string,
  workerId: string,
): Promise<ResumeOutcome> {
  "use step";

  const interaction = await runApp(
    claimIMessageInteractionResume({ interactionId, workerId }),
  );
  if (interaction === null) return "settled";

  const state =
    interaction.state !== null &&
    typeof interaction.state === "object" &&
    !Array.isArray(interaction.state)
      ? (interaction.state as Record<string, unknown>)
      : {};
  const result =
    interaction.result !== null &&
    typeof interaction.result === "object" &&
    !Array.isArray(interaction.result)
      ? (interaction.result as Record<string, unknown>)
      : {};
  if (interaction.kind === "imessage_command_approval") {
    const completed = await runApp(
      completeIMessageInteractionResume({ interactionId, workerId }),
    );
    return completed ? "complete" : "settled";
  }
  const deploymentUrl =
    typeof state.deploymentUrl === "string" ? state.deploymentUrl : "";
  const sessionId = typeof state.sessionId === "string" ? state.sessionId : "";
  const continuationToken =
    typeof state.continuationToken === "string" ? state.continuationToken : "";
  const optionId =
    typeof result.optionId === "string" ? result.optionId : undefined;
  const value = typeof result.value === "string" ? result.value : undefined;

  const resumed =
    deploymentUrl.length > 0 &&
    sessionId.length > 0 &&
    continuationToken.length > 0 &&
    (await runApp(
      resumeIMessageInteraction({
        deploymentUrl,
        sessionId,
        continuationToken,
        requestId: interaction.eveRequestId,
        ...(optionId === undefined ? {} : { optionId }),
        ...(value === undefined ? {} : { value }),
      }),
    ));

  if (resumed) {
    const completed = await runApp(
      completeIMessageInteractionResume({ interactionId, workerId }),
    );
    return completed ? "complete" : "settled";
  }

  await runApp(
    releaseIMessageInteractionResume({
      interactionId,
      workerId,
      errorCode:
        deploymentUrl.length === 0 ||
        sessionId.length === 0 ||
        continuationToken.length === 0
          ? "IMESSAGE_INTERACTION_RESUME_STATE_INVALID"
          : "IMESSAGE_INTERACTION_RESUME_FAILED",
    }),
  );
  return "retry";
}

async function restartInteractionResumeStep(
  interactionId: string,
): Promise<void> {
  "use step";
  await start(
    imessageInteractionResumeWorkflow,
    [interactionId, randomUUID()],
    { deploymentId: "latest" },
  );
}
