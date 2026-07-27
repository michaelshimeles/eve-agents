import { put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerOnly } from "../lib/owner-gate";

// Bridges the sandbox filesystem to Micky: the sandbox is invisible to him,
// so files the agent creates there (reports, exports, images, archives) get
// uploaded to public Vercel Blob storage and handed over as a download link.

const MAX_BYTES = 50 * 1024 * 1024;

export default defineTool({
  approval: ownerOnly,
  description:
    "Share a file from your sandbox with Micky: uploads it to file storage and returns a public download URL. Use this whenever you create a file he should receive (a report, CSV export, image, PDF, zip) instead of pasting its contents into chat. Give him the returned URL as a markdown link.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe('Sandbox path of the file, e.g. "report.csv" or "/workspace/out/summary.pdf".'),
    contentType: z
      .string()
      .optional()
      .describe('MIME type for the download, e.g. "application/pdf". Inferred when omitted.'),
  }),
  async execute({ path, contentType }, ctx) {
    const sandbox = await ctx.getSandbox();
    const bytes = await sandbox.readBinaryFile({ path });
    if (bytes === null) {
      throw new Error(`No file at ${sandbox.resolvePath(path)}. Check the path with glob or bash.`);
    }
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error(
        `File is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the sharing limit is 50 MB. Compress or split it first.`,
      );
    }

    const name = path.split("/").filter(Boolean).at(-1) ?? "file";
    const blob = await put(`shared/${name}`, Buffer.from(bytes), {
      access: "public",
      addRandomSuffix: true,
      ...(contentType !== undefined ? { contentType } : {}),
    });

    return {
      url: blob.url,
      filename: name,
      sizeBytes: bytes.byteLength,
      note: "Public URL - anyone with the link can download it.",
    };
  },
});
