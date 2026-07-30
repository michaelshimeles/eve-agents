/**
 * Full AI span bodies can contain MCP tool results. Agentcard card details
 * deliberately include PAN and CVV in their human-readable result, so body
 * capture must be disabled whenever the Agentcard backend is enabled.
 *
 * Structural telemetry remains intact: spans, timing, token counts, and tool
 * names are still exported. Only inputs/outputs are suppressed.
 */
export function shouldRecordTelemetryIo(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const requested = env.OTEL_RECORD_IO !== "false";
  const clientId = env.AGENTCARD_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.AGENTCARD_CLIENT_SECRET?.trim() ?? "";
  const agentcardEnabled = clientId.length > 0 && clientSecret.length > 0;
  return requested && !agentcardEnabled;
}
