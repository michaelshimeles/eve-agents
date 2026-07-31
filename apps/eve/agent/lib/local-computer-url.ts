import { isIPv4 } from "node:net";

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = unbracket(hostname).toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIPv4(normalized) && normalized.split(".")[0] === "127";
}

/**
 * A Ruth Local bearer authorizes shell and GUI control of the owner's Mac.
 * Never attach it to plaintext transport beyond the local machine.
 */
export function parseLocalComputerMcpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("RUTH_LOCAL_MCP_URL is not a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RUTH_LOCAL_MCP_URL must use http or https.");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(
      "RUTH_LOCAL_MCP_URL must use HTTPS unless it points to localhost, 127.0.0.0/8, or ::1.",
    );
  }
  return url;
}
