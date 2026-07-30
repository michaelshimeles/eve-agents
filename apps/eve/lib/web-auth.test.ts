import { describe, expect, it } from "vitest";

import {
  requireWebAuth,
  WEB_OWNER_PRINCIPAL_ID,
  webRequestPrincipal,
} from "./web-auth";

describe("open web access", () => {
  it("uses a stable owner scope for public requests", () => {
    expect(webRequestPrincipal()).toEqual({
      principalId: WEB_OWNER_PRINCIPAL_ID,
    });
  });

  it("does not challenge forwarded or credential-bearing requests", () => {
    const request = new Request("https://ruth.example/api/files", {
      headers: {
        authorization: "Basic ignored",
        "x-forwarded-for": "203.0.113.5",
      },
    });
    expect(requireWebAuth(request)).toBeNull();
  });
});
