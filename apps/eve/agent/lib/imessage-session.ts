import { createHash } from "node:crypto";

interface PairingSessionIdentity {
  readonly handle: string;
  readonly secret: string;
}

interface IMessageInputOption {
  readonly id: string;
  readonly label: string;
}

interface IMessageInputRequest {
  readonly allowFreeform?: boolean;
  readonly display?: "confirmation" | "select" | "text";
  readonly options?: readonly IMessageInputOption[];
  readonly prompt: string;
}

/**
 * A new pairing gets a fresh secret, so including a non-reversible fingerprint
 * keeps a re-paired handle out of any old session parked on approval or auth.
 */
export function imessageContinuationToken(
  pairing: PairingSessionIdentity,
  space: string | null,
): string {
  const generation = createHash("sha256")
    .update(pairing.secret)
    .digest("base64url")
    .slice(0, 16);
  return space === null
    ? `dm:${pairing.handle}:${generation}`
    : `group:${space}:${generation}`;
}

/** Token shape used before pairing generations were added. */
export function legacyIMessageContinuationToken(
  handle: string,
  space: string | null,
): string {
  return space === null ? handle : `group:${space}`;
}

/** `/new` is deliberately exact so ordinary prose cannot retire a session. */
export function isIMessageResetCommand(
  text: string | null,
  hasFiles: boolean,
): boolean {
  return !hasFiles && text?.trim().toLowerCase() === "/new";
}

/** Render HITL requests into choices a plain-text iMessage user can answer. */
export function renderIMessageInputRequests(
  requests: readonly IMessageInputRequest[],
): string {
  const prompts = requests.map((request) => {
    if (request.display === "confirmation") {
      return `${request.prompt}\nReply APPROVE to continue or DENY to cancel.`;
    }

    const options = request.options ?? [];
    if (options.length > 0) {
      const choices = options
        .map((option, index) => `${index + 1}. ${option.label}`)
        .join("\n");
      const answer = request.allowFreeform
        ? "Reply with a number, option label, or your own answer."
        : "Reply with a number or option label.";
      return `${request.prompt}\n${choices}\n${answer}`;
    }

    return `${request.prompt}\nReply with your answer.`;
  });

  return `${prompts.join("\n\n")}\n\nReply /new anytime to start a fresh conversation.`;
}
