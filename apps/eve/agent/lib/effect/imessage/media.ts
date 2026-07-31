import { createGateway } from "@ai-sdk/gateway";
import { generateSpeech, transcribe } from "ai";
import { Data, Effect } from "effect";

export class IMessageMediaError extends Data.TaggedError("IMessageMediaError")<{
  readonly operation: "transcription" | "speech";
  readonly detail: string;
}> {}

function gatewayProvider() {
  const apiKey = process.env.AI_GATEWAY_API_KEY?.trim();
  return createGateway(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey });
}

export interface IMessageTranscript {
  readonly text: string;
  readonly durationSeconds?: number;
  readonly language?: string;
  readonly segments: readonly {
    readonly text: string;
    readonly startSecond: number;
    readonly endSecond: number;
  }[];
}

export interface IMessageSpeech {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly fileName: string;
}

export function transcribeIMessageAudio(
  bytes: Uint8Array,
): Effect.Effect<IMessageTranscript, IMessageMediaError> {
  return Effect.tryPromise({
    try: async () => {
      const gateway = gatewayProvider();
      const result = await transcribe({
        model: gateway.transcriptionModel(
          (process.env.IMESSAGE_STT_MODEL?.trim() ||
            "openai/gpt-4o-transcribe") as Parameters<typeof gateway.transcriptionModel>[0],
        ),
        audio: bytes,
        maxRetries: 2,
        abortSignal: AbortSignal.timeout(120_000),
      });
      return {
        text: result.text,
        ...(result.durationInSeconds === undefined
          ? {}
          : { durationSeconds: result.durationInSeconds }),
        ...(result.language === undefined ? {} : { language: result.language }),
        segments: result.segments,
      };
    },
    catch: (cause) =>
      new IMessageMediaError({
        operation: "transcription",
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

export function synthesizeIMessageSpeech(
  text: string,
): Effect.Effect<IMessageSpeech, IMessageMediaError> {
  return Effect.tryPromise({
    try: async () => {
      const gateway = gatewayProvider();
      const result = await generateSpeech({
        model: gateway.speechModel(
          (process.env.IMESSAGE_TTS_MODEL?.trim() ||
            "xai/grok-tts") as Parameters<typeof gateway.speechModel>[0],
        ),
        text,
        voice: process.env.IMESSAGE_TTS_VOICE?.trim() || "eve",
        outputFormat: "mp3",
        maxRetries: 2,
        abortSignal: AbortSignal.timeout(120_000),
      });
      return {
        bytes: result.audio.uint8Array,
        mediaType: result.audio.mediaType,
        fileName: "ruth-voice.mp3",
      };
    },
    catch: (cause) =>
      new IMessageMediaError({
        operation: "speech",
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}
