import { parseLocalComputerMcpUrl } from "./local-computer-url";

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export function directLocalComputerConfigured(): boolean {
  return (
    env("RUTH_LOCAL_MCP_URL") !== undefined &&
    (env("RUTH_LOCAL_MCP_TOKEN")?.length ?? 0) >= 32
  );
}

export function localComputerRelayConfigured(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

export function localComputerAvailable(): boolean {
  return directLocalComputerConfigured() || localComputerRelayConfigured();
}

function automaticOrigin(): string {
  const explicit = env("RUTH_LOCAL_RELAY_ORIGIN");
  if (explicit !== undefined) return explicit.replace(/\/+$/, "");
  const deploymentHost = env("VERCEL_URL");
  if (deploymentHost !== undefined) return `https://${deploymentHost}`;
  const productionHost = env("VERCEL_PROJECT_PRODUCTION_URL");
  if (productionHost !== undefined) return `https://${productionHost}`;
  return "http://127.0.0.1:3000";
}

/**
 * An explicit direct-tunnel URL remains the operator escape hatch. Otherwise
 * Eve talks to its own stable reverse-relay route, which the Mac polls
 * outbound.
 */
export function configuredLocalComputerMcpUrl(): URL {
  const direct = directLocalComputerConfigured()
    ? env("RUTH_LOCAL_MCP_URL")
    : undefined;
  return parseLocalComputerMcpUrl(
    direct ?? `${automaticOrigin()}/api/local-computer/mcp`,
  );
}

export function localComputerUsesDirectTunnel(): boolean {
  return directLocalComputerConfigured();
}
