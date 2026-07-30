import { describe, expect, it } from "vitest";

import { renderInboundContent } from "./imessage";

describe("renderInboundContent", () => {
  it("returns plain text unchanged", () => {
    expect(renderInboundContent({ type: "text", text: "hey" })).toEqual({
      text: "hey",
      files: [],
      audio: [],
    });
  });

  it("ignores blank text", () => {
    expect(renderInboundContent({ type: "text", text: "   " })).toEqual({
      text: null,
      files: [],
      audio: [],
    });
  });

  it("forwards a viewable image attachment as a file", () => {
    expect(
      renderInboundContent({
        type: "attachment",
        id: "att_1",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: 1024,
      }),
    ).toEqual({
      text: null,
      files: [{ id: "att_1", name: "photo.jpg", mimeType: "image/jpeg" }],
      audio: [],
    });
  });

  it("forwards a PDF attachment as a file", () => {
    expect(
      renderInboundContent({
        type: "attachment",
        id: "att_2",
        name: "invoice.pdf",
        mimeType: "application/pdf",
        size: 2048,
      }),
    ).toEqual({
      text: null,
      files: [{ id: "att_2", name: "invoice.pdf", mimeType: "application/pdf" }],
      audio: [],
    });
  });

  it("classifies a reasonably sized voice memo as transcribable audio, not a note", () => {
    expect(
      renderInboundContent({
        type: "attachment",
        id: "att_3",
        name: "voice-memo.m4a",
        mimeType: "audio/m4a",
        size: 500_000,
      }),
    ).toEqual({
      text: null,
      files: [],
      audio: [{ id: "att_3", name: "voice-memo.m4a", mimeType: "audio/m4a" }],
    });
  });

  it("falls back to an honest note for an oversized voice memo", () => {
    const result = renderInboundContent({
      type: "attachment",
      id: "att_4",
      name: "long-story.caf",
      mimeType: "audio/caf",
      size: 30 * 1024 * 1024,
    });
    expect(result.files).toEqual([]);
    expect(result.audio).toEqual([]);
    expect(result.text).toContain("too large to transcribe");
    expect(result.text).toContain("long-story.caf");
  });

  it("falls back to an honest note for audio with no attachment id", () => {
    const result = renderInboundContent({
      type: "attachment",
      name: "voice-memo.m4a",
      mimeType: "audio/m4a",
      size: 500_000,
    });
    expect(result.files).toEqual([]);
    expect(result.audio).toEqual([]);
    expect(result.text).toContain("too large to transcribe");
  });

  it("still leaves video as an honest note", () => {
    const result = renderInboundContent({
      type: "attachment",
      id: "att_5",
      name: "clip.mov",
      mimeType: "video/quicktime",
      size: 500_000,
    });
    expect(result.files).toEqual([]);
    expect(result.audio).toEqual([]);
    expect(result.text).toContain("cannot watch");
  });

  it("still refuses an oversized non-audio attachment", () => {
    const result = renderInboundContent({
      type: "attachment",
      id: "att_6",
      name: "archive.zip",
      mimeType: "application/zip",
      size: 30 * 1024 * 1024,
    });
    expect(result.files).toEqual([]);
    expect(result.audio).toEqual([]);
    expect(result.text).toContain("too large for you to open");
  });

  it("aggregates text, files, and audio across a group of arms", () => {
    const result = renderInboundContent({
      type: "group",
      items: [
        { content: { type: "text", text: "check these out" } },
        {
          content: {
            type: "attachment",
            id: "att_7",
            name: "photo.png",
            mimeType: "image/png",
            size: 100,
          },
        },
        {
          content: {
            type: "attachment",
            id: "att_8",
            name: "voice.m4a",
            mimeType: "audio/m4a",
            size: 100,
          },
        },
      ],
    });
    expect(result.text).toBe("check these out");
    expect(result.files).toEqual([{ id: "att_7", name: "photo.png", mimeType: "image/png" }]);
    expect(result.audio).toEqual([{ id: "att_8", name: "voice.m4a", mimeType: "audio/m4a" }]);
  });

  it("wakes the agent for a group of only files and audio, with no text", () => {
    const result = renderInboundContent({
      type: "group",
      items: [
        {
          content: {
            type: "attachment",
            id: "att_9",
            name: "voice.m4a",
            mimeType: "audio/m4a",
            size: 100,
          },
        },
      ],
    });
    expect(result.text).toBeNull();
    expect(result.audio).toEqual([{ id: "att_9", name: "voice.m4a", mimeType: "audio/m4a" }]);
  });

  it("ignores reactions and unknown arms", () => {
    expect(renderInboundContent({ type: "reaction", emoji: "❤️" })).toEqual({
      text: null,
      files: [],
      audio: [],
    });
  });
});
