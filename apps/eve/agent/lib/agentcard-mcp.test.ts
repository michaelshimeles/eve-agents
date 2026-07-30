import { describe, expect, it, vi } from "vitest";

import connection, {
  agentcardApproval,
  agentcardAuthorization,
  agentcardNeedsApproval,
} from "../connections/agentcard";

describe("Agentcard MCP connection", () => {
  it("registers every server tool dynamically and uses bearer-only auth", async () => {
    expect(connection.tools).toBeUndefined();
    expect(typeof connection.auth).toBe("function");

    const read = vi.fn().mockResolvedValue({
      token: "user_connection_access_token",
      expiresAt: 1_800_000_000_000,
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const resolveAuth = agentcardAuthorization(read, refresh);
    const provider = resolveAuth();

    expect(provider).not.toHaveProperty("startAuthorization");
    expect(provider).not.toHaveProperty("completeAuthorization");
    expect(provider.principalType).toBe("app");
    await expect(provider.getToken()).resolves.toEqual({
      token: "user_connection_access_token",
      expiresAt: 1_800_000_000_000,
    });
  });

  it("refreshes the exact rejected bearer from the turn-local auth provider", async () => {
    const read = vi.fn().mockResolvedValue({
      token: "user_at_rejected",
      expiresAt: null,
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const provider = agentcardAuthorization(read, refresh)();

    await provider.getToken();
    await provider.evict();
    await provider.evict();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("user_at_rejected");
  });

  it("gates card creation, credential access, and provider approval", () => {
    expect(agentcardNeedsApproval("agentcard__get_card_details")).toBe(true);
    expect(agentcardNeedsApproval("agentcard__create_card")).toBe(true);
    expect(agentcardNeedsApproval("agentcard__approve_request")).toBe(true);
    expect(agentcardNeedsApproval("create_card")).toBe(true);
    expect(agentcardNeedsApproval("approve_request")).toBe(true);
  });

  it("fails closed for dynamically discovered tools", () => {
    expect(agentcardNeedsApproval("agentcard__transfer_funds")).toBe(true);
    expect(agentcardNeedsApproval("agentcard__future_provider_action")).toBe(true);
    expect(agentcardNeedsApproval("agentcard__buy")).toBe(true);
    expect(agentcardNeedsApproval("agentcard__get_balance")).toBe(false);
    expect(agentcardNeedsApproval("list_transactions")).toBe(false);

    const context = (toolName: string) =>
      ({
        toolName,
        session: { auth: { current: null, initiator: null } },
      }) as Parameters<typeof agentcardApproval>[0];
    expect(agentcardApproval(context("agentcard__transfer_funds"))).toBe(
      "user-approval",
    );
    expect(agentcardApproval(context("agentcard__get_balance"))).toBe(
      "not-applicable",
    );
  });
});
