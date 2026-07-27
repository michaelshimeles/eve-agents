import type { LanguageModelMiddleware, ModelMessage } from "ai";
import { gateway, wrapLanguageModel } from "ai";
import { defineAgent, defineDynamic } from "eve";

import { FALLBACK_DEFAULT_MODEL_ID, getDefaultModelId } from "./lib/gateway-models";

const MODEL_ID_PATTERN = /^[\w.-]+\/[\w.:-]+$/;

/** The AI SDK's provider-agnostic reasoning effort levels, minus the default. */
const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
type ReasoningLevel = (typeof REASONING_LEVELS)[number];

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

const CLIENT_CONTEXT_PREFIX = "Client context:\n";

interface TurnSettings {
  model: string | null;
  reasoning: ReasoningLevel | null;
}

const NO_SETTINGS: TurnSettings = { model: null, reasoning: null };

/**
 * The web chat attaches `{ eveWebModel, eveWebReasoning? }` as one-turn
 * `clientContext`, which the eve channel delivers as a user-role message of
 * the exact form `Client context:\n<json>`. Scan the visible conversation
 * from the end for a message that parses to that shape, so ordinary
 * conversation text merely mentioning the keys cannot match.
 */
function requestedSettings(messages: readonly ModelMessage[]): TurnSettings {
  for (let index = messages.length - 1; index >= 0; index--) {
    const { content } = messages[index];
    const texts =
      typeof content === "string"
        ? [content]
        : content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""));
    for (const text of texts) {
      const settings = parseSettingsMarker(text);
      if (settings !== null) return settings;
    }
  }
  return NO_SETTINGS;
}

function parseSettingsMarker(text: string): TurnSettings | null {
  if (!text.startsWith(CLIENT_CONTEXT_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(CLIENT_CONTEXT_PREFIX.length));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const modelValue = record.eveWebModel;
    const model =
      typeof modelValue === "string" && MODEL_ID_PATTERN.test(modelValue) ? modelValue : null;
    const reasoning = isReasoningLevel(record.eveWebReasoning) ? record.eveWebReasoning : null;
    if (model === null && reasoning === null) return null;
    return { model, reasoning };
  } catch {
    return null;
  }
}

function reasoningMiddleware(reasoning: ReasoningLevel): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => ({
      ...params,
      reasoning: params.reasoning ?? reasoning,
      providerOptions: {
        ...params.providerOptions,
        // eve enables the gateway's automatic prompt caching for string model
        // ids only; a live model bypasses that path, so re-apply it here.
        gateway: { caching: "auto", ...params.providerOptions?.gateway },
      },
    }),
  };
}

export default defineAgent({
  build: {
    // Remotion's bundler/renderer pull in webpack/rspack and platform
    // binaries (headless shell, compositor) that must stay external; eve
    // traces them into the hosted output instead of bundling them.
    // heif2jpeg is a native addon (HEIC photo conversion for iMessage
    // attachments) with the same constraint.
    externalDependencies: ["remotion", "@remotion/bundler", "@remotion/renderer", "heif2jpeg"],
  },
  model: defineDynamic({
    // Compile-time anchor + last resort when the live catalog is unreachable.
    // Prefer getDefaultModelId() at turn start so new Sonnet drops land
    // without bumping this string.
    fallback: FALLBACK_DEFAULT_MODEL_ID,
    events: {
      "turn.started": async (_event, ctx) => {
        const requested = requestedSettings(ctx.messages).model;
        if (requested !== null) return requested;
        // Channels without a picker (Telegram, schedules) ride the newest
        // preferred family from the Gateway catalog.
        return getDefaultModelId();
      },
      // Reasoning effort is a per-call AI SDK setting, not a field the dynamic
      // model selection object accepts, so a requested level rides on a live
      // gateway model wrapped with default settings. Live models are only
      // allowed from step.started; with no level requested this returns null
      // and the turn-scoped string selection (plain prompt-cache path) wins.
      "step.started": async (_event, ctx) => {
        const { model, reasoning } = requestedSettings(ctx.messages);
        if (reasoning === null) return null;
        return wrapLanguageModel({
          model: gateway(model ?? (await getDefaultModelId())),
          middleware: reasoningMiddleware(reasoning),
        });
      },
    },
  }),
});
