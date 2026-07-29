import { BraintrustExporter } from "@braintrust/otel";
import { registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

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
const RECORD_IO = process.env.OTEL_RECORD_IO !== "false";
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
      !USE_VERCEL_PRODUCTION_COLLECTOR
    ) {
      return;
    }

    registerOTel({
      serviceName: agentName,
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
