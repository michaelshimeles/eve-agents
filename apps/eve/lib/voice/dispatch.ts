// Bridges ask_ruth calls from the voice model into the real eve agent over the
// existing web channel. One eve session per voice conversation (Ruth keeps
// context across dispatches); one turn in flight at a time.
import type { UserContent } from "ai";
import { Client, type HandleMessageStreamEvent } from "eve/client";

import { toUserContent, type VoiceAttachment } from "./attachments";
import { dispatchOutcome, type DispatchOutcome } from "./bridge";

export interface DispatchResult extends DispatchOutcome {
  events: HandleMessageStreamEvent[];
  busy?: boolean;
}

/** Structural slice of ClientSession so tests can inject a fake. */
export interface DispatchSession {
  readonly state: {
    readonly continuationToken?: string;
    readonly sessionId?: string;
    readonly streamIndex?: number;
  };
  send(input: {
    message?: string | UserContent;
    clientContext?: Record<string, unknown>;
    inputResponses?: ReadonlyArray<{ requestId: string; optionId?: string; text?: string }>;
  }): Promise<AsyncIterable<HandleMessageStreamEvent>>;
  cancel(options?: { turnId?: string }): Promise<unknown>;
}

const BUSY_RESULT: DispatchResult = {
  reply: null,
  parked: null,
  failure: null,
  authorization: null,
  events: [],
  busy: true,
};

export class RuthDispatcher {
  private readonly session: DispatchSession;
  private inFlight = false;

  constructor(resumeToken?: string, session?: DispatchSession) {
    this.session =
      session ?? (new Client({ host: "" }).session(resumeToken) as unknown as DispatchSession);
  }

  get busy(): boolean {
    return this.inFlight;
  }

  get continuationToken(): string | undefined {
    return this.session.state.continuationToken;
  }

  dispatch(
    request: string,
    clientContext: Record<string, unknown>,
    attachments: readonly VoiceAttachment[] = [],
    onToolStarted?: (toolName: string) => void,
  ): Promise<DispatchResult> {
    // A plain string when nothing is attached keeps the common case identical
    // to what it was before attachments existed.
    const message = attachments.length === 0 ? request : toUserContent(request, attachments);
    return this.run({ message, clientContext }, onToolStarted);
  }

  answer(
    responses: ReadonlyArray<{ requestId: string; optionId?: string; text?: string }>,
    onToolStarted?: (toolName: string) => void,
  ): Promise<DispatchResult> {
    return this.run({ inputResponses: responses }, onToolStarted);
  }

  /**
   * Stop the running turn — the spoken equivalent of the chat stop button.
   * Cancellation is cooperative: the in-flight `run` settles on its own stream
   * with `turn.cancelled`, so this only asks.
   */
  async cancel(): Promise<boolean> {
    if (!this.inFlight) return false;
    try {
      await this.session.cancel();
      return true;
    } catch {
      return false;
    }
  }

  private async run(
    payload: Parameters<DispatchSession["send"]>[0],
    onToolStarted?: (toolName: string) => void,
  ): Promise<DispatchResult> {
    if (this.inFlight) return BUSY_RESULT;
    this.inFlight = true;
    const events: HandleMessageStreamEvent[] = [];
    try {
      const response = await this.session.send(payload);
      for await (const event of response) {
        events.push(event);
        if (event.type === "actions.requested") {
          for (const action of event.data.actions) {
            if (action.kind === "tool-call") onToolStarted?.(action.toolName);
            else if (action.kind === "subagent-call") onToolStarted?.(action.subagentName);
          }
        }
      }
      return { ...dispatchOutcome(events), events };
    } catch (error) {
      return {
        reply: null,
        parked: null,
        failure: error instanceof Error ? error.message : String(error),
        authorization: null,
        events,
      };
    } finally {
      this.inFlight = false;
    }
  }
}
