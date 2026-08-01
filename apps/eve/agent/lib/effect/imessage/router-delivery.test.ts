import { describe, expect, it } from "vitest";

import { attachmentIds, replaceAttachmentIds } from "./router-delivery";

describe("iMessage router media references", () => {
  it("binds and replaces native voice provider ids", () => {
    const content = {
      type: "voice",
      id: "provider-voice-guid",
      name: "Audio Message.caf",
      mimeType: "audio/x-caf",
      size: 4_096,
    };

    expect(attachmentIds(content)).toEqual(["provider-voice-guid"]);
    expect(
      replaceAttachmentIds(
        content,
        new Map([["provider-voice-guid", "imsg_ref_voice"]]),
      ),
    ).toEqual({ ...content, id: "imsg_ref_voice" });
  });

  it("binds voice ids nested in a grouped message", () => {
    const content = {
      type: "group",
      items: [
        { content: { type: "text", text: "listen" } },
        {
          content: {
            type: "voice",
            id: "provider-voice-guid",
            mimeType: "audio/mp4",
          },
        },
      ],
    };

    expect(attachmentIds(content)).toEqual(["provider-voice-guid"]);
    expect(
      replaceAttachmentIds(
        content,
        new Map([["provider-voice-guid", "imsg_ref_voice"]]),
      ),
    ).toMatchObject({
      items: [
        { content: { type: "text" } },
        { content: { type: "voice", id: "imsg_ref_voice" } },
      ],
    });
  });

  it("rejects whitespace-only voice ids directly and in grouped messages", () => {
    const voice = {
      type: "voice",
      id: "   ",
      mimeType: "audio/mp4",
    };
    const grouped = {
      type: "group",
      items: [{ content: voice }],
    };
    const refs = new Map([["   ", "imsg_ref_invalid"]]);

    expect(attachmentIds(voice)).toEqual([]);
    expect(attachmentIds(grouped)).toEqual([]);
    expect(replaceAttachmentIds(voice, refs)).toEqual(voice);
    expect(replaceAttachmentIds(grouped, refs)).toEqual(grouped);
  });
});
