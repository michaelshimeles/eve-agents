import type { ModelMessage } from "ai";
import { defineAgent, defineDynamic } from "eve";

const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

const MODEL_ID_PATTERN = /^[\w.-]+\/[\w.:-]+$/;

const CLIENT_CONTEXT_PREFIX = "Client context:\n";

/**
 * The web chat attaches `{ eveWebModel }` as one-turn `clientContext`, which
 * the eve channel delivers as a user-role message of the exact form
 * `Client context:\n<json>`. Scan the visible conversation from the end for a
 * message that parses to that shape, so ordinary conversation text merely
 * mentioning the key cannot match.
 */
function requestedModel(messages: readonly ModelMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const { content } = messages[index];
    const texts =
      typeof content === "string"
        ? [content]
        : content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""));
    for (const text of texts) {
      const model = parseModelMarker(text);
      if (model !== null) return model;
    }
  }
  return null;
}

function parseModelMarker(text: string): string | null {
  if (!text.startsWith(CLIENT_CONTEXT_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(CLIENT_CONTEXT_PREFIX.length));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const model = (parsed as Record<string, unknown>).eveWebModel;
    return typeof model === "string" && MODEL_ID_PATTERN.test(model) ? model : null;
  } catch {
    return null;
  }
}

export default defineAgent({
  model: defineDynamic({
    fallback: DEFAULT_MODEL,
    events: {
      "turn.started": (_event, ctx) => requestedModel(ctx.messages),
    },
  }),
});
