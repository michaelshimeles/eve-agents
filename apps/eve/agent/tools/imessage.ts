import { isChannel } from "eve/instrumentation";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import imessage from "../channels/imessage";
import {
  IMESSAGE_EFFECTS,
  sendIMessageEffect,
  sendIMessageReaction,
  setIMessageBackground,
} from "../lib/effect/imessage";
import { runTool } from "../lib/effect/runtime";

// iMessage-only conversational tools, resolved per turn so they exist exactly
// when the session lives on the iMessage channel (see send_attachment.ts for
// the same pattern). Each closes over the paired handle and line from channel
// metadata — the model can never aim them at anyone else.

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!isChannel(ctx.channel, imessage)) return null;
      const { handle, phone, space } = ctx.channel.metadata;
      if (handle === null || handle.length === 0) return null;
      // DM-only: every op here is handle-addressed (the owner's 1:1 chat),
      // so a group session gets none of them — a tapback or effect aimed at
      // the DM from inside a group would land in the wrong conversation.
      if (space !== null) return null;
      const pinned = phone !== null ? { phone } : {};
      // The tapback target must be THIS turn's inbound message; the turn's
      // auth attributes carry it fresh (the metadata projection can lag).
      const attributes = ctx.session.auth.current?.attributes ?? {};
      const rawMessageId = (attributes as Record<string, unknown>).message_id;
      const messageId = typeof rawMessageId === "string" ? rawMessageId : null;

      return {
        ...(messageId !== null && messageId.length > 0
          ? {
              react: defineTool({
                description:
                  "React to Micky's message with an iMessage tapback. ❤️ 👍 👎 😂 ‼️ ❓ render as native tapbacks; any other emoji shows as an emoji reaction on his message. Use it when a reaction says it better than a sentence — acknowledging, agreeing, finding something funny — then keep whatever reply you still need short.",
                inputSchema: z.object({
                  emoji: z.string().min(1).describe('A single emoji, e.g. "👍" or "❤️".'),
                }),
                async execute({ emoji }) {
                  await runTool(
                    sendIMessageReaction({
                      handle,
                      reaction: { emoji, targetMessageId: messageId },
                      ...pinned,
                    }),
                  );
                  return { reacted: true };
                },
              }),
            }
          : {}),

        send_effect: defineTool({
          description:
            "Send Micky a text with an iMessage effect — confetti, balloons, fireworks, lasers, sparkles, heart, celebration, spotlight, echo (full-screen), or slam, loud, gentle, invisible (bubble effects). Reserve it for moments that deserve one: birthdays, wins, big news. The text goes out immediately as its own message, so don't repeat it in your reply.",
          inputSchema: z.object({
            text: z.string().min(1).describe("The message to send with the effect."),
            effect: z.enum(IMESSAGE_EFFECTS).describe("Which effect to send it with."),
          }),
          async execute({ text, effect }) {
            await runTool(sendIMessageEffect({ handle, text, effect, ...pinned }));
            return {
              sent: true,
              note: "Delivered with the effect. Don't repeat this text in your reply.",
            };
          },
        }),

        set_chat_background: defineTool({
          description:
            "Set or clear the background image of this iMessage conversation. Only do this when Micky asks for it. Pass a public https image URL to set, or clear: true to remove the current background.",
          inputSchema: z.object({
            url: z.string().optional().describe("Public https URL of the background image."),
            clear: z.boolean().optional().describe("Remove the current background instead."),
          }),
          async execute({ url, clear }) {
            const background = clear === true ? "clear" : (url ?? "");
            if (background.length === 0) {
              throw new Error("Pass an image url, or clear: true.");
            }
            await runTool(setIMessageBackground({ handle, background, ...pinned }));
            return { done: true };
          },
        }),
      };
    },
  },
});
