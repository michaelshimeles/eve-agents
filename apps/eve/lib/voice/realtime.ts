// Thin wrapper around a WebRTC session to OpenAI Realtime (GA API). Owns the
// peer connection, mic track, remote-audio element, and "oai-events" data
// channel; surfaces typed callbacks and takes typed commands. No app logic
// lives here — see lib/voice/bridge.ts.
import { DEFAULT_MAX_MESSAGE_BYTES, parseMaxMessageBytes } from "./attachments";
import { describeHandshakeFailure } from "./bridge";

export interface RealtimeFunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface RealtimeCallbacks {
  /** Live user-speech transcript; final=true when the utterance is complete. */
  onUserTranscript?: (text: string, final: boolean) => void;
  /** Live assistant transcript; final=true at end of the spoken response. */
  onAssistantTranscript?: (text: string, final: boolean) => void;
  /** Assistant started/stopped producing a response (drives the speaking state). */
  onAssistantSpeaking?: (speaking: boolean) => void;
  /** Server VAD detected the user talking (barge-in; server auto-interrupts). */
  onUserSpeechStarted?: () => void;
  /** Server VAD detected the user stopped talking. */
  onUserSpeechStopped?: () => void;
  onFunctionCall?: (call: RealtimeFunctionCall) => void;
  /**
   * A problem occurred. `fatal` means the session is gone (already closed by
   * this wrapper); a non-fatal error is informational and the session lives on.
   */
  onError?: (message: string, fatal: boolean) => void;
  onClosed?: () => void;
}

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/**
 * Realtime error codes that do not end the session: a transcription hiccup or
 * a rejected extra response would otherwise tear down a perfectly good call.
 * Everything else is treated as fatal — leaving a broken session open means a
 * hot microphone and a metered connection nobody is watching.
 */
const NON_FATAL_ERROR_PATTERN = /transcription|already_has_an_active_response|active_response|cancellation_failed|not_active/i;

export class RealtimeVoiceSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private userPartial = "";
  private assistantPartial = "";
  private closed = false;
  /** Realtime allows one in-progress response at a time. */
  private responseActive = false;
  /** Instructions for a response that was requested while one was active. */
  private queuedResponse: { instructions?: string } | null = null;
  private maxBytes = DEFAULT_MAX_MESSAGE_BYTES;

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  async connect(secret: string): Promise<void> {
    const pc = new RTCPeerConnection();
    this.pc = pc;

    const audio = document.createElement("audio");
    audio.autoplay = true;
    this.audio = audio;
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0] ?? null;
    };

    this.mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = this.mic.getTracks()[0];
    if (track !== undefined) pc.addTrack(track, this.mic);

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.addEventListener("message", (event) => this.handleEvent(event.data as string));

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.close();
        this.callbacks.onError?.("Voice connection dropped", true);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await fetch(CALLS_URL, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/sdp" },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      this.close();
      throw new Error(describeHandshakeFailure(response.status, body));
    }
    const answer = await response.text();
    this.maxBytes = parseMaxMessageBytes(answer);
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  }

  /** Largest single data-channel message this connection accepts. */
  get maxMessageBytes(): number {
    return this.maxBytes;
  }

  private handleEvent(raw: string): void {
    let event: { type?: string } & Record<string, unknown>;
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return;
    }
    switch (event.type) {
      case "conversation.item.input_audio_transcription.delta": {
        this.userPartial += String(event.delta ?? "");
        this.callbacks.onUserTranscript?.(this.userPartial, false);
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        this.userPartial = "";
        const transcript = String(event.transcript ?? "").trim();
        if (transcript.length > 0) this.callbacks.onUserTranscript?.(transcript, true);
        break;
      }
      case "response.output_audio_transcript.delta": {
        this.assistantPartial += String(event.delta ?? "");
        this.callbacks.onAssistantTranscript?.(this.assistantPartial, false);
        break;
      }
      case "response.output_audio_transcript.done": {
        this.assistantPartial = "";
        const transcript = String(event.transcript ?? "").trim();
        if (transcript.length > 0) this.callbacks.onAssistantTranscript?.(transcript, true);
        break;
      }
      case "response.created":
        this.responseActive = true;
        this.callbacks.onAssistantSpeaking?.(true);
        break;
      case "response.done": {
        this.responseActive = false;
        this.callbacks.onAssistantSpeaking?.(false);
        const queued = this.queuedResponse;
        this.queuedResponse = null;
        if (queued !== null) this.createResponse(queued.instructions);
        break;
      }
      case "input_audio_buffer.speech_started":
        this.callbacks.onUserSpeechStarted?.();
        break;
      case "input_audio_buffer.speech_stopped":
        this.callbacks.onUserSpeechStopped?.();
        break;
      case "response.function_call_arguments.done": {
        const callId = String(event.call_id ?? "");
        const name = String(event.name ?? "");
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(String(event.arguments ?? "{}")) as Record<string, unknown>;
        } catch {
          // leave args empty; the handler treats a missing request as an error
        }
        if (callId.length > 0 && name.length > 0) this.callbacks.onFunctionCall?.({ callId, name, args });
        break;
      }
      case "error": {
        const error = event.error as { message?: string; type?: string; code?: string } | undefined;
        const detail = error?.message ?? "Realtime error";
        const fatal = !NON_FATAL_ERROR_PATTERN.test(`${error?.type ?? ""} ${error?.code ?? ""} ${detail}`);
        if (fatal) {
          // A broken session must not be left running: the mic stays live and
          // the connection keeps billing even though nothing is listening.
          this.close();
          this.callbacks.onError?.(detail, true);
        } else {
          this.responseActive = false;
          this.callbacks.onError?.(detail, false);
        }
        break;
      }
      default:
        break;
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.dc === null || this.dc.readyState !== "open") return;
    this.dc.send(JSON.stringify(event));
  }

  sendFunctionOutput(callId: string, output: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
  }

  /** Add context the model can use without making it speak. */
  addContextItem(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
    });
  }

  /**
   * Show the model an image. Must be a `user` item — `input_image` is not
   * valid on a system item — and the data URI must be PNG or JPEG.
   */
  addImageItem(dataUrl: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: dataUrl }],
      },
    });
  }

  /**
   * Trigger a spoken response, optionally steered by one-off instructions.
   * Only one response may be in progress; a request made while the model is
   * already speaking is held until that response finishes rather than being
   * rejected by the server.
   */
  createResponse(instructions?: string): void {
    if (this.closed) return;
    if (this.responseActive) {
      this.queuedResponse = { instructions };
      return;
    }
    this.send(
      instructions === undefined
        ? { type: "response.create" }
        : { type: "response.create", response: { instructions } },
    );
  }

  /** True while the wrapper still owns a live connection. */
  get isOpen(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.mic = null;
    try {
      this.dc?.close();
    } catch {
      // already closed
    }
    this.dc = null;
    try {
      this.pc?.close();
    } catch {
      // already closed
    }
    this.pc = null;
    if (this.audio !== null) {
      this.audio.srcObject = null;
      this.audio = null;
    }
    this.callbacks.onClosed?.();
  }
}
