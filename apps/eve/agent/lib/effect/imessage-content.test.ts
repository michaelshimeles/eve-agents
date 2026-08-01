import { describe, expect, it } from "vitest";

import { renderInboundContent } from "./imessage";

describe("iMessage native audio classification", () => {
  it("distinguishes a native voice memo from an ordinary audio attachment", () => {
    const voice = renderInboundContent({
      type: "attachment",
      id: "voice",
      name: "memo.caf",
      mimeType: "audio/x-caf",
      size: 1_024,
      isAudioMessage: true,
    });
    const file = renderInboundContent({
      type: "attachment",
      id: "song",
      name: "song.m4a",
      mimeType: "audio/mp4",
      size: 2_048,
      isAudioMessage: false,
    });

    expect(voice.audio).toEqual([
      {
        id: "voice",
        name: "memo.caf",
        mimeType: "audio/x-caf",
        isVoiceMemo: true,
      },
    ]);
    expect(file.audio).toEqual([
      {
        id: "song",
        name: "song.m4a",
        mimeType: "audio/mp4",
        isVoiceMemo: false,
      },
    ]);
  });

  it("keeps webhook audio backward compatible when Photon omits the flag", () => {
    expect(
      renderInboundContent({
        type: "attachment",
        id: "legacy",
        name: "voice.m4a",
        mimeType: "audio/mp4",
        size: 2_048,
      }).audio[0],
    ).toEqual({
      id: "legacy",
      name: "voice.m4a",
      mimeType: "audio/mp4",
    });
  });

  it("classifies Spectrum's native voice content arm as a voice memo", () => {
    expect(
      renderInboundContent({
        type: "voice",
        id: "voice-guid",
        name: "Audio Message.caf",
        mimeType: "audio/x-caf",
        size: 4_096,
      }),
    ).toEqual({
      text: null,
      files: [],
      audio: [
        {
          id: "voice-guid",
          name: "Audio Message.caf",
          mimeType: "audio/x-caf",
          isVoiceMemo: true,
        },
      ],
      processable: [],
    });
  });

  it("does not silently discard a voice webhook without a downloadable id", () => {
    const content = renderInboundContent({
      type: "voice",
      name: "Audio Message.caf",
      mimeType: "audio/x-caf",
      size: 4_096,
    });

    expect(content.text).toContain("native voice memo");
    expect(content.audio).toEqual([]);
  });

  it("treats a whitespace-only native voice id as unavailable", () => {
    const content = renderInboundContent({
      type: "voice",
      id: "   ",
      name: "Audio Message.caf",
      mimeType: "audio/x-caf",
      size: 4_096,
    });

    expect(content.text).toContain("audio was unavailable");
    expect(content.audio).toEqual([]);
  });
});
