import { describe, expect, it } from "vitest";

import { localComputerNeedsApproval } from "../connections/local-computer";
import {
  configuredLocalComputerMcpUrl,
  localComputerAvailable,
} from "./local-computer-relay-url";
import { parseLocalComputerMcpUrl } from "./local-computer-url";

describe("parseLocalComputerMcpUrl", () => {
  it("accepts HTTPS for remote bridge hosts", () => {
    expect(parseLocalComputerMcpUrl("https://ruth-local.example.com/mcp").href).toBe(
      "https://ruth-local.example.com/mcp",
    );
  });

  it.each([
    "http://localhost:4317/mcp",
    "http://127.0.0.1:4317/mcp",
    "http://127.255.255.254:4317/mcp",
    "http://[::1]:4317/mcp",
  ])("accepts plaintext only for a strict loopback host: %s", (url) => {
    expect(parseLocalComputerMcpUrl(url)).toBeInstanceOf(URL);
  });

  it.each([
    "http://192.168.1.25:4317/mcp",
    "http://0.0.0.0:4317/mcp",
    "http://ruth-local.example.com/mcp",
    "http://localhost.example.com/mcp",
    "http://127.0.0.1.example.com/mcp",
  ])("rejects plaintext for non-loopback hosts: %s", (url) => {
    expect(() => parseLocalComputerMcpUrl(url)).toThrow(
      "must use HTTPS unless it points to localhost",
    );
  });

  it("rejects non-HTTP protocols before a credential can be attached", () => {
    expect(() => parseLocalComputerMcpUrl("ftp://127.0.0.1/mcp")).toThrow(
      "must use http or https",
    );
  });
});

describe("localComputerNeedsApproval", () => {
  it("requires approval for every filesystem mutation", () => {
    expect(localComputerNeedsApproval("local-computer__write_text")).toBe(true);
    expect(localComputerNeedsApproval("local-computer__make_directory")).toBe(true);
    expect(localComputerNeedsApproval("local-computer__move_path")).toBe(true);
    expect(localComputerNeedsApproval("local-computer__trash_path")).toBe(true);
    expect(localComputerNeedsApproval("local-computer__delete_path")).toBe(true);
    expect(localComputerNeedsApproval("local-computer__shell")).toBe(true);
    expect(localComputerNeedsApproval("local-computer__read_binary")).toBe(true);
    expect(localComputerNeedsApproval("local-computer__write_binary")).toBe(true);
    expect(localComputerNeedsApproval("local-computer__computer_screenshot")).toBe(true);
  });

  it("does not prompt for scoped read-only operations", () => {
    expect(localComputerNeedsApproval("local-computer__roots")).toBe(false);
    expect(localComputerNeedsApproval("local-computer__list_files")).toBe(false);
    expect(localComputerNeedsApproval("local-computer__stat_path")).toBe(false);
    expect(localComputerNeedsApproval("local-computer__read_text")).toBe(false);
    expect(localComputerNeedsApproval("local-computer__search_text")).toBe(false);
  });

  it("fails safe by requiring approval for any future or unknown tool", () => {
    expect(localComputerNeedsApproval("local-computer__unknown")).toBe(true);
  });
});

describe("Ruth Local reverse-relay URL", () => {
  it("uses the production deployment URL without local-computer secrets", () => {
    const previousDirect = process.env.RUTH_LOCAL_MCP_URL;
    const previousProduction = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const previousDeployment = process.env.VERCEL_URL;
    const previousDatabase = process.env.DATABASE_URL;
    delete process.env.RUTH_LOCAL_MCP_URL;
    delete process.env.VERCEL_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "ruth.example.com";
    process.env.DATABASE_URL = "postgres://configured";
    try {
      expect(configuredLocalComputerMcpUrl().href).toBe(
        "https://ruth.example.com/api/local-computer/mcp",
      );
      expect(localComputerAvailable()).toBe(true);
    } finally {
      if (previousDirect === undefined) delete process.env.RUTH_LOCAL_MCP_URL;
      else process.env.RUTH_LOCAL_MCP_URL = previousDirect;
      if (previousProduction === undefined) {
        delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      } else {
        process.env.VERCEL_PROJECT_PRODUCTION_URL = previousProduction;
      }
      if (previousDeployment === undefined) delete process.env.VERCEL_URL;
      else process.env.VERCEL_URL = previousDeployment;
      if (previousDatabase === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabase;
    }
  });

  it("keeps the explicit direct tunnel as the operator override", () => {
    const previousUrl = process.env.RUTH_LOCAL_MCP_URL;
    const previousToken = process.env.RUTH_LOCAL_MCP_TOKEN;
    process.env.RUTH_LOCAL_MCP_URL = "https://direct.example.com/mcp";
    process.env.RUTH_LOCAL_MCP_TOKEN = "direct-token".padEnd(43, "x");
    try {
      expect(configuredLocalComputerMcpUrl().href).toBe(
        "https://direct.example.com/mcp",
      );
    } finally {
      if (previousUrl === undefined) delete process.env.RUTH_LOCAL_MCP_URL;
      else process.env.RUTH_LOCAL_MCP_URL = previousUrl;
      if (previousToken === undefined) delete process.env.RUTH_LOCAL_MCP_TOKEN;
      else process.env.RUTH_LOCAL_MCP_TOKEN = previousToken;
    }
  });

  it("ignores a stale direct URL when its bearer token is missing", () => {
    const previousUrl = process.env.RUTH_LOCAL_MCP_URL;
    const previousToken = process.env.RUTH_LOCAL_MCP_TOKEN;
    const previousDeployment = process.env.VERCEL_URL;
    process.env.RUTH_LOCAL_MCP_URL = "https://stale.example.com/mcp";
    delete process.env.RUTH_LOCAL_MCP_TOKEN;
    process.env.VERCEL_URL = "preview.example.com";
    try {
      expect(configuredLocalComputerMcpUrl().href).toBe(
        "https://preview.example.com/api/local-computer/mcp",
      );
    } finally {
      if (previousUrl === undefined) delete process.env.RUTH_LOCAL_MCP_URL;
      else process.env.RUTH_LOCAL_MCP_URL = previousUrl;
      if (previousToken === undefined) delete process.env.RUTH_LOCAL_MCP_TOKEN;
      else process.env.RUTH_LOCAL_MCP_TOKEN = previousToken;
      if (previousDeployment === undefined) delete process.env.VERCEL_URL;
      else process.env.VERCEL_URL = previousDeployment;
    }
  });
});
