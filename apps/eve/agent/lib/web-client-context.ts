import type { ModelMessage } from "ai";

const CLIENT_CONTEXT_PREFIX = "Client context:\n";

export function webClientContext(
  messages: readonly ModelMessage[],
): Record<string, unknown> | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const content = messages[index]?.content;
    if (content === undefined) continue;
    const texts =
      typeof content === "string"
        ? [content]
        : content.map((part) =>
            "text" in part && typeof part.text === "string" ? part.text : "",
          );
    for (const text of texts) {
      if (!text.startsWith(CLIENT_CONTEXT_PREFIX)) continue;
      try {
        const parsed: unknown = JSON.parse(text.slice(CLIENT_CONTEXT_PREFIX.length));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Keep scanning older, valid context markers.
      }
    }
  }
  return null;
}

export function webThreadId(messages: readonly ModelMessage[]): string | null {
  const value = webClientContext(messages)?.eveWebThreadId;
  return typeof value === "string" && value.length > 0 ? value : null;
}
