import { describe, expect, it } from "vitest";

import { localComputerNeedsApproval } from "../connections/local-computer";
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
