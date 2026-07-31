import { defineMcpClientConnection } from "eve/connections";

import { localComputerAgentCredential } from "../lib/effect/local-computer-relay";
import { runApp } from "../lib/effect/runtime";
import {
  configuredLocalComputerMcpUrl,
  localComputerUsesDirectTunnel,
} from "../lib/local-computer-relay-url";
import { guestDenial } from "../lib/owner-gate";

// Eve derives the connection name from this file: local-computer.
const READ_ONLY_TOOLS = new Set([
  "list_files",
  "read_text",
  "roots",
  "search_text",
  "stat_path",
]);

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

async function requiredToken(): Promise<string> {
  if (!localComputerUsesDirectTunnel()) {
    return (await runApp(localComputerAgentCredential())).token;
  }
  const token = nonEmptyEnv("RUTH_LOCAL_MCP_TOKEN");
  if (token !== undefined && token.length >= 32) return token;
  throw new Error(
    "Ruth Local is not paired. Connect the Mac under Manage -> Computer.",
  );
}

function bareToolName(qualified: string): string {
  const separator = qualified.lastIndexOf("__");
  return separator === -1 ? qualified : qualified.slice(separator + 2);
}

export function localComputerNeedsApproval(toolName: string): boolean {
  return !READ_ONLY_TOOLS.has(bareToolName(toolName));
}

function cloudflareAccessHeaders(): Record<string, () => string> {
  if (!localComputerUsesDirectTunnel()) return {};
  const clientId = nonEmptyEnv("RUTH_LOCAL_CF_ACCESS_CLIENT_ID");
  const clientSecret = nonEmptyEnv("RUTH_LOCAL_CF_ACCESS_CLIENT_SECRET");
  if (clientId === undefined && clientSecret === undefined) return {};
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(
      "Set both RUTH_LOCAL_CF_ACCESS_CLIENT_ID and RUTH_LOCAL_CF_ACCESS_CLIENT_SECRET, or neither.",
    );
  }
  return {
    "CF-Access-Client-Id": () => clientId,
    "CF-Access-Client-Secret": () => clientSecret,
  };
}

export default defineMcpClientConnection({
  url: configuredLocalComputerMcpUrl().href,
  description:
    "The owner's real local Mac. Use scoped tools for files in explicitly shared roots; with owner approval, run arbitrary user-level zsh, transfer binary files, overwrite or move data, recoverably trash it, or delete it permanently. A separate local_computer_task tool handles screenshot-driven GUI work. This is not Ruth's sandbox or cloud desktop.",
  auth: {
    getToken: async () => ({ token: await requiredToken() }),
  },
  headers: cloudflareAccessHeaders(),
  tools: {
    allow: [
      "roots",
      "list_files",
      "stat_path",
      "read_text",
      "search_text",
      "write_text",
      "read_binary",
      "write_binary",
      "make_directory",
      "move_path",
      "trash_path",
      "delete_path",
      "shell",
      "computer_screenshot",
    ],
  },
  approval: (context) =>
    guestDenial(context) ??
    (localComputerNeedsApproval(context.toolName) ? "user-approval" : "not-applicable"),
});
