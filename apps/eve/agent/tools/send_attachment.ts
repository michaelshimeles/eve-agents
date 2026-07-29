import { isChannel } from "eve/instrumentation";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import imessage from "../channels/imessage";
import { sendIMessageAttachment } from "../lib/effect/imessage";
import { runTool } from "../lib/effect/runtime";

// iMessage-only: delivers a file as a native attachment bubble instead of a
// pasted link. Resolved per turn so it exists exactly when the session lives
// on the iMessage channel and the pairing handle is known — on the web chat
// (where markdown links render inline) the tool is not advertised at all.

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!isChannel(ctx.channel, imessage)) return null;
      const { handle, phone, space } = ctx.channel.metadata;
      if (handle === null || handle.length === 0) return null;
      // DM-only: attachment sends are handle-addressed (the owner's 1:1
      // chat), so group sessions don't advertise this tool.
      if (space !== null) return null;
      return defineTool({
        description:
          "Send Micky a file over iMessage as a native attachment — an image arrives as a real picture bubble in the conversation, not a link. Use this whenever he should receive an image or file (a screenshot, photo, PDF, export): for files in your sandbox, upload with share_file first and pass the URL it returns. Any public https URL works. After sending, don't paste the URL into your reply too unless he asks for a link.",
        inputSchema: z.object({
          url: z.string().describe("Public https URL of the file to send."),
          name: z
            .string()
            .optional()
            .describe('Filename shown on the attachment, e.g. "screenshot.png". Inferred when omitted.'),
          contentType: z
            .string()
            .optional()
            .describe('MIME type, e.g. "image/png". Inferred when omitted.'),
        }),
        async execute({ url, name, contentType }) {
          await runTool(
            sendIMessageAttachment({
              handle,
              file: {
                url,
                ...(name !== undefined ? { name } : {}),
                ...(contentType !== undefined ? { contentType } : {}),
              },
              ...(phone !== null ? { phone } : {}),
            }),
          );
          return {
            delivered: true,
            note: "Sent as an iMessage attachment. No need to repeat the URL in your reply.",
          };
        },
      });
    },
  },
});
