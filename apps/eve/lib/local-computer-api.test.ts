import { describe, expect, it } from "vitest";

import {
  bearerToken,
  localComputerApiFailure,
  stringField,
  stringRecord,
} from "./local-computer-api";

describe("Ruth Local API boundaries", () => {
  it("parses only a single bearer credential", () => {
    expect(
      bearerToken(
        new Request("https://ruth.example/api/local-computer/relay", {
          headers: { authorization: "Bearer device-secret" },
        }),
      ),
    ).toBe("device-secret");
    expect(
      bearerToken(
        new Request("https://ruth.example/api/local-computer/relay", {
          headers: { authorization: "Basic device-secret" },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["Ruth Local relay authorization failed: inactive token", 401],
    ["Ruth Local relay request was not found: expired", 404],
    ["Ruth Local pairing expired: request another link", 410],
    ["Ruth Local is offline: the Mac did not answer", 504],
    ["Ruth Local is not paired: connect the Mac", 409],
    ["Ruth Local relay is not configured: DATABASE_URL is required", 503],
  ])("maps %s to HTTP %i", (message, status) => {
    expect(localComputerApiFailure(new Error(message)).status).toBe(status);
  });

  it("accepts only bounded strings and string-valued records", () => {
    expect(stringField({ name: "Mac" }, "name", 3)).toBe("Mac");
    expect(stringField({ name: "MacBook" }, "name", 3)).toBe("");
    expect(stringRecord({ accept: "application/json", count: 2 })).toEqual({
      accept: "application/json",
    });
  });
});
