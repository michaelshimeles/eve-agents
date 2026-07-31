const INBOUND_EMAIL_PREFIX = "New email in your own inbox (";
const BODY_START = "\nBody:\n```\n";
const BODY_END = "\n```\n\nTriage it:";

export interface InboundEmailPrompt {
  from: string;
  to: string;
  subject: string;
  received: string;
  threadId: string;
  messageId: string;
  body: string;
}

/**
 * Recognizes the internal prompt used to wake Ruth for an incoming email.
 * The full prompt remains in the session for the model, while the chat can
 * present the useful fields without exposing the triage instructions.
 */
export function parseInboundEmailPrompt(text: string): InboundEmailPrompt | null {
  if (!text.startsWith(INBOUND_EMAIL_PREFIX)) return null;

  const bodyStart = text.indexOf(BODY_START);
  const bodyEnd = text.lastIndexOf(BODY_END);
  if (bodyStart < 0 || bodyEnd <= bodyStart) return null;

  const header = text.slice(0, bodyStart);
  const from = headerValue(header, "From");
  const to = headerValue(header, "To");
  const subject = headerValue(header, "Subject");
  const received = headerValue(header, "Received");
  const threadId = headerValue(header, "Thread id");
  const messageId = headerValue(header, "Message id");
  if (
    from === null ||
    to === null ||
    subject === null ||
    received === null ||
    threadId === null ||
    messageId === null
  ) {
    return null;
  }

  return {
    from,
    to,
    subject,
    received,
    threadId,
    messageId,
    body: text.slice(bodyStart + BODY_START.length, bodyEnd).trim(),
  };
}

/** Turns newsletter-style whitespace into a short, readable chat preview. */
export function compactEmailPreview(body: string, maxChars = 320): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}…`;
}

function headerValue(header: string, label: string): string | null {
  const prefix = `${label}: `;
  const line = header.split("\n").find((entry) => entry.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}
