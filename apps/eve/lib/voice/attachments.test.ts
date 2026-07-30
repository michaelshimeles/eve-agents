import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_GLANCE_BYTES,
  MAX_STAGED_FILES,
  describeAttachments,
  glanceBudget,
  isGlanceable,
  parseMaxMessageBytes,
  rejectionNote,
  stageAttachments,
  toUserContent,
  type VoiceAttachment,
} from "./attachments";

/** A File whose bytes never actually get read at the sizes we care about. */
function fakeFile(name: string, size: number, type = "image/png"): File {
  const file = new File([new Uint8Array(Math.min(size, 8))], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

const img: VoiceAttachment = {
  id: "1",
  name: "shot.png",
  mediaType: "image/png",
  size: 2048,
  dataUrl: "data:image/png;base64,AAAA",
};
const pdf: VoiceAttachment = {
  id: "2",
  name: "invoice.pdf",
  mediaType: "application/pdf",
  size: 3_000_000,
  dataUrl: "data:application/pdf;base64,BBBB",
};

describe("toUserContent", () => {
  it("matches the shape the chat composer sends", () => {
    expect(toUserContent("what is this?", [img])).toEqual([
      { type: "text", text: "what is this?" },
      { type: "file", data: "data:image/png;base64,AAAA", mediaType: "image/png", filename: "shot.png" },
    ]);
  });
  it("omits the text part when the request is empty", () => {
    const parts = toUserContent("", [img]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "file" });
  });
  it("carries every attachment", () => {
    expect(toUserContent("x", [img, pdf])).toHaveLength(3);
  });
});

describe("parseMaxMessageBytes", () => {
  it("reads the negotiated limit from the SDP answer", () => {
    expect(parseMaxMessageBytes("v=0\r\na=max-message-size:262144\r\na=sendrecv\r\n")).toBe(262144);
  });
  it("falls back to 64 KiB when absent or malformed", () => {
    expect(parseMaxMessageBytes("v=0\r\na=sendrecv\r\n")).toBe(DEFAULT_MAX_MESSAGE_BYTES);
    expect(parseMaxMessageBytes("a=max-message-size:banana")).toBe(DEFAULT_MAX_MESSAGE_BYTES);
    expect(parseMaxMessageBytes("a=max-message-size:0")).toBe(DEFAULT_MAX_MESSAGE_BYTES);
  });
});

describe("glanceBudget", () => {
  it("leaves headroom for base64 inflation and the JSON envelope", () => {
    const budget = glanceBudget(65536);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(65536 * 0.75);
  });
  it("scales with a larger negotiated limit", () => {
    expect(glanceBudget(262144)).toBeGreaterThan(glanceBudget(65536));
  });
});

describe("isGlanceable", () => {
  it("accepts raster images the canvas can re-encode", () => {
    expect(isGlanceable("image/png")).toBe(true);
    expect(isGlanceable("image/jpeg")).toBe(true);
    expect(isGlanceable("image/webp")).toBe(true);
  });
  it("rejects non-images and formats browsers cannot decode", () => {
    expect(isGlanceable("application/pdf")).toBe(false);
    expect(isGlanceable("image/heic")).toBe(false);
    expect(isGlanceable("image/svg+xml")).toBe(false);
  });
});

describe("spoken notes", () => {
  it("describes attachments for the voice model", () => {
    expect(describeAttachments([pdf])).toContain("invoice.pdf");
    expect(describeAttachments([pdf])).toMatch(/2\.9 MB|3\.0 MB|2\.86 MB/);
  });
  it("names every rejected file and why", () => {
    const note = rejectionNote([{ name: "huge.mov", reason: "too_large" }]);
    expect(note).toContain("huge.mov");
    expect(note).toContain("too large");
    expect(rejectionNote([])).toBeNull();
  });
});

describe("stageAttachments", () => {
  it("rejects files over the per-file cap and keeps the rest", async () => {
    const result = await stageAttachments(
      [fakeFile("ok.png", 1_000), fakeFile("huge.mov", MAX_ATTACHMENT_BYTES + 1, "video/quicktime")],
      0,
    );
    expect(result.accepted.map((a) => a.name)).toEqual(["ok.png"]);
    expect(result.rejected).toEqual([{ name: "huge.mov", reason: "too_large" }]);
  });

  it("enforces the staging cap, counting files already staged", async () => {
    const files = Array.from({ length: 4 }, (_, i) => fakeFile(`f${i}.png`, 10));
    const result = await stageAttachments(files, MAX_STAGED_FILES - 2);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((r) => r.reason === "too_many")).toBe(true);
  });

  it("names an unnamed paste and defaults an unknown media type", async () => {
    const result = await stageAttachments([fakeFile("", 10, "")], 0);
    expect(result.accepted[0].name).toBe("pasted-file");
    expect(result.accepted[0].mediaType).toBe("application/octet-stream");
  });

  it("encodes the original bytes, across base64 chunk boundaries", async () => {
    // The reader base64s the file in 32 KiB slices; this one spans three, so a
    // mishandled boundary would corrupt what both the glance and the agent see.
    const bytes = new Uint8Array(0x14000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    const file = new File([bytes], "blob.bin", { type: "application/octet-stream" });
    const { accepted } = await stageAttachments([file], 0);
    const dataUrl = accepted[0].dataUrl;
    expect(dataUrl.startsWith("data:application/octet-stream;base64,")).toBe(true);
    const decoded = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (character) =>
      character.charCodeAt(0),
    );
    expect(decoded).toEqual(bytes);
  });

  it("reads every file when the caller's list is emptied mid-flight", async () => {
    // Reproduces the picker bug: input.value = "" empties the live FileList
    // right after the call, so anything read lazily would be lost.
    const live = [fakeFile("a.png", 10), fakeFile("b.png", 10), fakeFile("c.png", 10)];
    const promise = stageAttachments(live, 0);
    live.length = 0;
    expect((await promise).accepted).toHaveLength(3);
  });
});

describe("glance budget clamping", () => {
  it("never exceeds the cost ceiling even when the peer allows huge messages", () => {
    expect(glanceBudget(512 * 1024 * 1024)).toBe(MAX_GLANCE_BYTES);
  });
  it("never goes negative on a tiny negotiated limit", () => {
    expect(glanceBudget(1_000)).toBe(0);
  });
});
