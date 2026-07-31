import { Cause } from "effect";
import { describe, expect, it } from "vitest";

import { AgentcardError } from "@/agent/lib/effect/agentcard";

import { agentcardFailure } from "./agentcard-http";

describe("agentcardFailure", () => {
  it("tells the client to re-prompt on invalid_code", async () => {
    const response = agentcardFailure(
      Cause.fail(
        new AgentcardError({
          reason: "provider",
          status: 401,
          code: "invalid_code",
          detail: "The code is invalid.",
          docs: "https://docs.test/codes",
        }),
      ),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_code",
        message: "The code is invalid.",
        docs: "https://docs.test/codes",
      },
      retryCode: true,
    });
  });

  it("tells the client to restart on invalid_connect_attempt", async () => {
    const response = agentcardFailure(
      Cause.fail(
        new AgentcardError({
          reason: "provider",
          status: 400,
          code: "invalid_connect_attempt",
          detail: "The attempt expired.",
        }),
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_connect_attempt",
        message: "The attempt expired.",
      },
      restart: true,
    });
  });

  it("does not confuse a provider bearer failure with the app admin gate", async () => {
    const response = agentcardFailure(
      Cause.fail(
        new AgentcardError({
          reason: "provider",
          status: 401,
          code: "unauthorized",
          detail: "Platform token was rejected.",
        }),
      ),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Platform token was rejected.",
      },
    });
  });
});
