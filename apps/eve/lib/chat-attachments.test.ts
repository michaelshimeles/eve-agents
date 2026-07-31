import { describe, expect, it, vi } from "vitest";

import {
  MODEL_IMAGE_BUDGET_BYTES,
  toModelUserContent,
  type PreparedChatAttachment,
} from "./chat-attachments";

const smallImage: PreparedChatAttachment = {
  name: "small.png",
  mediaType: "image/png",
  size: 2_048,
  dataUrl: "data:image/png;base64,AAAA",
};

describe("toModelUserContent", () => {
  it("keeps a normal image as a real file part for the vision model", async () => {
    const scale = vi.fn();
    const content = await toModelUserContent(
      "What is shown?",
      [smallImage],
      scale,
    );
    expect(content).toEqual([
      { type: "text", text: "What is shown?" },
      {
        type: "file",
        data: smallImage.dataUrl,
        mediaType: "image/png",
        filename: "small.png",
      },
    ]);
    expect(scale).not.toHaveBeenCalled();
  });

  it("creates a JPEG visual copy when the original exceeds Eve's image ceiling", async () => {
    const scale = vi.fn().mockResolvedValue("data:image/jpeg;base64,BBBB");
    const content = await toModelUserContent(
      "",
      [
        {
          ...smallImage,
          name: "retina-shot.png",
          size: MODEL_IMAGE_BUDGET_BYTES + 1,
        },
      ],
      scale,
    );
    expect(scale).toHaveBeenCalledWith(
      smallImage.dataUrl,
      MODEL_IMAGE_BUDGET_BYTES,
      2048,
    );
    expect(content).toEqual([
      {
        type: "file",
        data: "data:image/jpeg;base64,BBBB",
        mediaType: "image/jpeg",
        filename: "retina-shot-for-ruth.jpg",
      },
    ]);
  });

  it("keeps the original if the browser cannot decode the image", async () => {
    const scale = vi.fn().mockResolvedValue(null);
    const large = { ...smallImage, size: MODEL_IMAGE_BUDGET_BYTES + 1 };
    expect(await toModelUserContent("", [large], scale)).toEqual([
      {
        type: "file",
        data: large.dataUrl,
        mediaType: "image/png",
        filename: "small.png",
      },
    ]);
  });

  it("keeps the original if the browser image scaler throws", async () => {
    const scale = vi.fn().mockRejectedValue(new Error("decoder crashed"));
    const large = { ...smallImage, size: MODEL_IMAGE_BUDGET_BYTES + 1 };
    expect(await toModelUserContent("", [large], scale)).toEqual([
      {
        type: "file",
        data: large.dataUrl,
        mediaType: "image/png",
        filename: "small.png",
      },
    ]);
  });
});
