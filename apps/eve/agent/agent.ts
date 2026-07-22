import type { ModelMessage } from "ai";
import { defineAgent, defineDynamic } from "eve";

const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

const MODEL_ID_PATTERN = /^[\w.-]+\/[\w.:-]+$/;

/**
 * The web chat attaches `{ eveWebModel }` as one-turn `clientContext`, which
 * the channel delivers as a JSON user-role context message. Scan the visible
 * conversation from the end for that marker.
 */
function requestedModel(messages: readonly ModelMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const { content } = messages[index];
    const texts =
      typeof content === "string"
        ? [content]
        : content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""));
    for (const text of texts) {
      const match = /"eveWebModel"\s*:\s*"([^"]+)"/.exec(text);
      if (match && MODEL_ID_PATTERN.test(match[1])) return match[1];
    }
  }
  return null;
}

export default defineAgent({
  model: defineDynamic({
    fallback: DEFAULT_MODEL,
    events: {
      "turn.started": (_event, ctx) => requestedModel(ctx.messages),
    },
  }),
});
