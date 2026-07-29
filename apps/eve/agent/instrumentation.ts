import { BraintrustExporter } from "@braintrust/otel";
import { registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";
import { createHash } from "node:crypto";
import { Raindrop } from "raindrop-ai";

export const RAINDROP_EVENT_NAME = "ruth_agent_turn";
export const RECORD_IO = process.env.OTEL_RECORD_IO !== "false";

const RAINDROP_NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
const raindropWriteKey = process.env.RAINDROP_WRITE_KEY?.trim() ?? "";

// Eve owns the OpenTelemetry provider. Raindrop contributes a processor to
// that provider, while the turn hook owns canonical begin/finish events.
export const raindrop =
  raindropWriteKey === ""
    ? null
    : new Raindrop({
        writeKey: raindropWriteKey,
        useExternalOtel: true,
        redactPii: true,
        disabled: process.env.NODE_ENV === "test",
      });

/** Stable UUIDv5 so hooks can resume the same event across durable invocations. */
export function raindropEventId(sessionId: string, turnId: string): string {
  const bytes = createHash("sha1")
    .update(RAINDROP_NAMESPACE)
    .update(`ruth:${sessionId}:${turnId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

interface SessionAuth {
  readonly current: { readonly principalId: string } | null;
  readonly initiator: { readonly principalId: string } | null;
}

export function raindropUserId(sessionId: string, auth: SessionAuth): string {
  return (auth.current ?? auth.initiator)?.principalId ?? `session:${sessionId}`;
}

// Per-channel-kind map: channel metadata projection -> span attribute names.
// Telegram and Slack are eve built-ins; the other projections are defined by
// this repo's channel files. Email, eve, and hooks project no metadata, so
// identity rides on session auth (ruth.principal below).
const METADATA_ATTRIBUTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "channel:telegram": {
    chatId: "ruth.telegram.chat_id",
    chatType: "ruth.telegram.chat_type",
    triggeringUserId: "ruth.telegram.user_id",
  },
  "channel:slack": {
    channelId: "ruth.slack.channel_id",
    teamId: "ruth.slack.team_id",
    threadTs: "ruth.slack.thread_ts",
    triggeringUserId: "ruth.slack.user_id",
  },
  "channel:imessage": {
    handle: "ruth.imessage.handle",
    space: "ruth.imessage.space",
  },
  "channel:agentphone": {
    target: "ruth.phone.target",
    conversationId: "ruth.phone.conversation_id",
    group: "ruth.phone.group",
  },
  "channel:agentphone-voice": {
    callId: "ruth.voice.call_id",
    from: "ruth.voice.from",
  },
};

function primitive(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

export function resolveBraintrustParent(
  agentName: string,
  configuredParent: string | undefined,
  projectId: string | undefined,
): string {
  if (configuredParent) return configuredParent;
  if (projectId) return `project_id:${projectId}`;
  return `project_name:${agentName}`;
}

// Single-user agent: traces carry the owner's real messages. Braintrust export
// is opt-in through its API key; the Marketplace integration provides both the
// key and destination project id. Without a direct exporter, production still
// registers Vercel's collector so a project-scoped Trace Drain can forward
// platform spans. OTEL_RECORD_IO=false keeps span structure (timings, tokens,
// tool names) while dropping message bodies.
const USE_VERCEL_PRODUCTION_COLLECTOR =
  process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production";

export default defineInstrumentation({
  recordInputs: RECORD_IO,
  recordOutputs: RECORD_IO,
  setup: ({ agentName }) => {
    const braintrustKey = process.env.BRAINTRUST_API_KEY ?? "";
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";
    if (
      braintrustKey === "" &&
      otlpEndpoint === "" &&
      !USE_VERCEL_PRODUCTION_COLLECTOR &&
      raindrop === null
    ) {
      return;
    }

    // "auto" preserves Vercel's collector and explicit OTLP export. Avoid it
    // for Raindrop-only local development, where it would probe localhost:4318.
    const useAutomaticSpanProcessors =
      USE_VERCEL_PRODUCTION_COLLECTOR || braintrustKey !== "" || otlpEndpoint !== "";

    registerOTel({
      serviceName: agentName,
      ...(raindrop !== null
        ? {
            spanProcessors: [
              ...(useAutomaticSpanProcessors ? (["auto"] as const) : []),
              raindrop.createSpanProcessor(),
            ],
          }
        : {}),
      ...(braintrustKey !== ""
        ? {
            traceExporter: new BraintrustExporter({
              parent: resolveBraintrustParent(
                agentName,
                process.env.BRAINTRUST_PARENT,
                process.env.BRAINTRUST_PROJECT_ID,
              ),
              filterAISpans: true,
            }),
          }
        : {}),
    });
  },
  events: {
    // Sync by contract; must not throw. Distinct from agent.ts's defineDynamic
    // step.started (model events vs instrumentation events — no conflict).
    "step.started"(input) {
      const runtimeContext: Record<string, string | number | boolean> = {};
      const auth = input.session.auth.current ?? input.session.auth.initiator;
      if (auth !== null) {
        runtimeContext["ruth.principal"] = auth.principalId;
        runtimeContext["ruth.authenticator"] = auth.authenticator;
      }
      if (raindrop !== null) {
        runtimeContext["raindrop.event_id"] = raindropEventId(input.session.id, input.turn.id);
        runtimeContext["raindrop.user_id"] = raindropUserId(input.session.id, input.session.auth);
        runtimeContext["raindrop.convo_id"] = input.session.id;
        runtimeContext["raindrop.event_name"] = RAINDROP_EVENT_NAME;
      }
      if (input.session.parent !== undefined) {
        runtimeContext["ruth.session.root"] = input.session.parent.rootSessionId;
        runtimeContext["ruth.session.parent"] = input.session.parent.sessionId;
      }
      const mapping = METADATA_ATTRIBUTES[input.channel.kind];
      if (mapping !== undefined) {
        for (const [key, attribute] of Object.entries(mapping)) {
          const value = primitive(input.channel.metadata[key]);
          if (value !== undefined) runtimeContext[attribute] = value;
        }
      }
      return { runtimeContext };
    },
  },
});
