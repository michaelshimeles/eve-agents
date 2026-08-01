import { describe, expect, it } from "vitest";

import {
  signOpaqueAttachmentAccess,
  verifyOpaqueAttachmentAccess,
} from "./imessage-signature";

describe("opaque iMessage attachment capabilities", () => {
  it("authorizes only the exact opaque ref, conversion mode, and expiry", () => {
    const secret = "s".repeat(64);
    const access = {
      ref: "imr_7b42b0f7",
      convert: true,
      expires: Math.floor(Date.now() / 1000) + 60,
    };
    const signature = signOpaqueAttachmentAccess(secret, access);

    expect(
      verifyOpaqueAttachmentAccess({ secret, signature, access }),
    ).toEqual({ ok: true });
    expect(
      verifyOpaqueAttachmentAccess({
        secret,
        signature,
        access: { ...access, ref: "imr_other" },
      }),
    ).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects expired capabilities", () => {
    const secret = "s".repeat(64);
    const access = {
      ref: "imr_expired",
      convert: false,
      expires: Math.floor(Date.now() / 1000) - 1,
    };
    const signature = signOpaqueAttachmentAccess(secret, access);
    expect(
      verifyOpaqueAttachmentAccess({ secret, signature, access }),
    ).toEqual({ ok: false, reason: "the attachment link expired" });
  });
});
