// Pure logic for the voice orb: transcript bookkeeping, dispatch outcome
// analysis, narration policy, and synthetic thread events. Everything here is
// framework-free so it can be unit tested without audio or DOM.
import type { HandleMessageStreamEvent, InputRequest, InputResponse } from "eve/client";

export const REUSE_WINDOW_MS = 30 * 60_000;
export const SILENCE_TIMEOUT_MS = 2 * 60_000;
export const NARRATION_GAP_MS = 8_000;
export const MAX_NARRATIONS_PER_DISPATCH = 3;
export const TRANSCRIPT_WINDOW_CAP = 40;

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface VoiceResumeRecord {
  threadId: string;
  title: string;
  endedAt: number;
  continuationToken?: string;
}

export interface DispatchOutcome {
  reply: string | null;
  parked: readonly InputRequest[] | null;
  failure: string | null;
  /** Name of a connection waiting on the owner to authorize it, if any. */
  authorization: string | null;
}

export function formatTranscript(entries: readonly TranscriptEntry[], assistantName: string): string {
  return entries.map((entry) => `${entry.role === "user" ? "User" : assistantName}: ${entry.text}`).join("\n");
}

export function transcriptWindow(
  entries: readonly TranscriptEntry[],
  sinceIndex: number,
  cap: number = TRANSCRIPT_WINDOW_CAP,
): TranscriptEntry[] {
  const fresh = entries.slice(Math.max(0, sinceIndex));
  return fresh.slice(Math.max(0, fresh.length - cap));
}

/** Rebuild transcript entries from a persisted voice-thread event log (thread reuse). */
export function transcriptFromEvents(events: readonly HandleMessageStreamEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const event of events) {
    if (event.type === "message.received" && typeof event.data.message === "string" && event.data.message.length > 0) {
      entries.push({ role: "user", text: event.data.message, at: 0 });
    }
    if (
      event.type === "message.completed" &&
      event.data.finishReason !== "tool-calls" &&
      typeof event.data.message === "string" &&
      event.data.message.length > 0
    ) {
      entries.push({ role: "assistant", text: event.data.message, at: 0 });
    }
  }
  return entries;
}

export function buildDispatchContext(
  transcript: readonly TranscriptEntry[],
  assistantName: string,
  now: Date = new Date(),
): { eveWebVoice: true; voiceTranscript?: string; clientTime: string } {
  const voiceTranscript = formatTranscript(transcript, assistantName);
  return {
    eveWebVoice: true,
    ...(voiceTranscript.length > 0 ? { voiceTranscript } : {}),
    clientTime: now.toLocaleString("en-CA", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }),
  };
}

const TOOL_PHRASES: Record<string, string> = {
  computer_task: "working on her computer",
  computer_bash: "running commands on her computer",
  computer_screenshot: "looking at her computer screen",
  computer_control: "checking on her computer",
};

const TOOL_PREFIX_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["browser", "browsing the web"],
  ["email", "working in her email"],
  ["memory", "checking her memory"],
  ["remember", "saving that to memory"],
  ["skill", "using one of her skills"],
];

export function toolPhrase(toolName: string): string {
  const exact = TOOL_PHRASES[toolName];
  if (exact !== undefined) return exact;
  const lowered = toolName.toLowerCase();
  for (const [prefix, phrase] of TOOL_PREFIX_PHRASES) {
    if (lowered.startsWith(prefix)) return phrase;
  }
  return `using ${toolName.replace(/[_-]+/g, " ").trim()}`;
}

/**
 * Decides when a tool start is worth interrupting the silence for. At most
 * MAX_NARRATIONS_PER_DISPATCH interjections per dispatch, never the same tool
 * twice, never while the user is talking, and after the first interjection at
 * least NARRATION_GAP_MS apart.
 */
export class NarrationGate {
  private lastNarrationAt = 0;
  private count = 0;
  private seenTools = new Set<string>();

  reset(): void {
    this.lastNarrationAt = 0;
    this.count = 0;
    this.seenTools.clear();
  }

  shouldNarrate(toolName: string, now: number, userSpeaking: boolean): boolean {
    if (userSpeaking) return false;
    if (this.count >= MAX_NARRATIONS_PER_DISPATCH) return false;
    if (this.seenTools.has(toolName)) return false;
    if (this.count > 0 && now - this.lastNarrationAt < NARRATION_GAP_MS) return false;
    this.seenTools.add(toolName);
    this.lastNarrationAt = now;
    this.count += 1;
    return true;
  }
}

/** Last completed assistant text that wasn't an interim before tool calls (web-thread-delivery pattern). */
export function finalReply(events: readonly HandleMessageStreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "message.completed") continue;
    if (event.data.finishReason === "tool-calls") continue;
    const message = event.data.message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return null;
}

export function dispatchOutcome(events: readonly HandleMessageStreamEvent[]): DispatchOutcome {
  let parked: readonly InputRequest[] | null = null;
  let failure: string | null = null;
  let authorization: string | null = null;
  for (const event of events) {
    if (event.type === "input.requested") parked = event.data.requests;
    if (event.type === "authorization.required") {
      // A connection needs the owner to sign in. Nothing can be done by voice,
      // but silently returning "done" would be a lie — name the connection so
      // the orb can send the user to the thread where the link is waiting.
      authorization = event.data.name;
    }
    if (event.type === "authorization.completed") authorization = null;
    if (event.type === "turn.failed" || event.type === "session.failed" || event.type === "step.failed") {
      failure = event.data.message;
    }
    if (event.type === "turn.completed") {
      parked = null;
      authorization = null;
    }
  }
  return { reply: finalReply(events), parked, failure, authorization };
}

export function describeInputRequests(requests: readonly InputRequest[]): string {
  return requests
    .map((request) => {
      const labels = (request.options ?? []).map((option) => option.label);
      return labels.length > 0 ? `${request.prompt} (options: ${labels.join(", ")})` : request.prompt;
    })
    .join(" Also: ");
}

const YES_PATTERN = /\b(yes|yeah|yep|sure|approve|approved|go ahead|do it|confirm|okay|ok)\b/i;
// Only genuine negations. Action verbs like "cancel" and "stop" are excluded on
// purpose: "yes, cancel it" approves cancelling something, and reading it as a
// denial would do the opposite of what was said.
const NO_PATTERN = /\b(no|nope|deny|denied|don't|dont|do not|reject|negative|never mind|nevermind)\b/i;

export function matchInputResponses(requests: readonly InputRequest[], answer: string): InputResponse[] {
  const normalized = answer.trim().toLowerCase();
  return requests.map((request) => {
    const options = request.options ?? [];
    const exact = options.find(
      (option) => option.label.toLowerCase() === normalized || option.id.toLowerCase() === normalized,
    );
    if (exact !== undefined) return { requestId: request.requestId, optionId: exact.id };
    const partial = options.filter((option) => {
      const label = option.label.toLowerCase();
      return normalized.includes(label) || label.includes(normalized);
    });
    if (partial.length === 1) return { requestId: request.requestId, optionId: partial[0].id };
    const approve = options.find((option) => option.id === "approve");
    const deny = options.find((option) => option.id === "deny");
    if (deny !== undefined && NO_PATTERN.test(answer)) return { requestId: request.requestId, optionId: deny.id };
    if (approve !== undefined && YES_PATTERN.test(answer)) return { requestId: request.requestId, optionId: approve.id };
    return { requestId: request.requestId, text: answer };
  });
}

/** A spoken user line, shaped so the default message reducer renders a user bubble. */
export function syntheticUserEvents(text: string, turnId: string, sequence: number): HandleMessageStreamEvent[] {
  return [
    {
      type: "message.received",
      data: { message: text, parts: [{ type: "text", text }], sequence, turnId },
    } as unknown as HandleMessageStreamEvent,
  ];
}

/** A spoken assistant line, shaped so the default message reducer renders an assistant bubble. */
export function syntheticAssistantEvents(text: string, turnId: string, sequence: number): HandleMessageStreamEvent[] {
  return [
    {
      type: "message.completed",
      data: { finishReason: "stop", message: text, sequence, stepIndex: 0, turnId },
    } as unknown as HandleMessageStreamEvent,
    { type: "turn.completed", data: { sequence: sequence + 1, turnId } } as unknown as HandleMessageStreamEvent,
  ];
}

/**
 * Dispatch turns are copied into the voice thread verbatim minus events that
 * only make sense on a live session: session boundaries (the thread stores no
 * cursor, and the continuation token belongs to the resume record) and pending
 * prompts (`input.requested` / `authorization.required`), which would otherwise
 * render in the saved thread as a live approval the reader cannot answer.
 */
const NON_PERSISTED_EVENTS = new Set(["input.requested", "authorization.required"]);

export function filterDispatchEvents(events: readonly HandleMessageStreamEvent[]): HandleMessageStreamEvent[] {
  return events.filter(
    (event) => !event.type.startsWith("session.") && !NON_PERSISTED_EVENTS.has(event.type),
  );
}

/**
 * Turns a failed Realtime handshake into something worth reading aloud in the
 * orb. The raw status alone ("failed (429)") hides the usual causes, which are
 * an unfunded account or a rate limit rather than anything the user did.
 */
export function describeHandshakeFailure(status: number, body: string): string {
  let code = "";
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    code = parsed.error?.code ?? "";
    message = parsed.error?.message ?? "";
  } catch {
    // non-JSON body: fall back to the status alone
  }
  if (code === "insufficient_quota") {
    return "Your OpenAI account is out of credit — add billing to use voice";
  }
  if (status === 429) return "OpenAI is rate limiting voice right now — try again shortly";
  if (status === 401 || status === 403) return "OpenAI rejected the voice session key";
  if (message.length > 0) return message.slice(0, 200);
  return `Voice connection failed (${status})`;
}

export function voiceThreadTitle(now: Date = new Date()): string {
  const stamp = now.toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Voice — ${stamp}`;
}

export function shouldReuseThread(record: VoiceResumeRecord | null, now: number): boolean {
  return record !== null && now - record.endedAt < REUSE_WINDOW_MS;
}
