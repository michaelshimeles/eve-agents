import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import {
  agentPhoneConfigured,
  checkIMessageCapability,
  phoneInbox,
  placePhoneCall,
  sendText,
} from "../lib/effect/agentphone";
import { runTool } from "../lib/effect/runtime";
import { ownerName } from "../lib/owner";
import { isGuestResolve, ownerOnly } from "../lib/owner-gate";

// Ruth's phone as tools: text someone, call someone, and read the verification
// codes that land on her own number.
//
// Resolved at turn.started rather than session.started for the same reason
// agent/tools/computer.ts is: a session resolves its dynamic tools once and
// replays them, so an old thread would never notice a key pasted in the UI
// after it began. Returning null when unconfigured keeps three dead tool
// schemas out of every model call on deployments with no phone.

/**
 * Verification codes are 4-8 digits, sometimes split by a space or hyphen for
 * legibility ("729 304"). Anchored on a word boundary so a price or an order
 * number in the same text is less likely to win.
 */
const CODE_PATTERN = /\b(\d{3}[\s-]?\d{3}|\d{4,8})\b/;

/** How far back a code is worth trusting. Most expire inside ten minutes. */
const CODE_WINDOW_MS = 15 * 60_000;

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      // Guests never see the phone at all — resolver-level gating, stronger
      // than an approval denial.
      if (isGuestResolve(ctx)) return null;
      if (!(await agentPhoneConfigured())) return null;
      const owner = ownerName();

      return {
        send_text: defineTool({
          approval: ownerOnly,
          description: `Text someone from your own phone number. Works for SMS and iMessage - the carrier picks. Use when ${owner} asks you to text a person, or when a short message is genuinely better sent as a text than said in chat. This sends a real message to a real phone, so get a yes from ${owner} before texting anyone other than him. Long replies are split into several texts, and each one is billed, so be brief.`,
          inputSchema: z.object({
            to: z
              .string()
              .min(1)
              .describe('Phone number in any format, or a group id starting with "grp_".'),
            text: z.string().min(1).max(4000).describe("The message. Plain text; no markdown."),
          }),
          async execute({ to, text }) {
            const sent = await runTool(sendText({ to, text }));
            return {
              sent: sent.length,
              channel: sent[0]?.channel ?? null,
              to: sent[0]?.to_number ?? to,
            };
          },
        }),

        can_imessage: defineTool({
          description:
            "Check whether a phone number can receive iMessage before you text it. Worth doing when the message is long, has an image, or would be awkward split across SMS segments - iMessage has none of those limits and costs nothing.",
          inputSchema: z.object({
            phone_number: z.string().min(1).describe("The number to check."),
          }),
          async execute({ phone_number }) {
            return await runTool(checkIMessageCapability(phone_number));
          },
        }),

        call_someone: defineTool({
          approval: ownerOnly,
          description: `Place a phone call from your own number. Use for errands that need a voice on the line - booking a table, chasing an order, asking a shop whether something is in stock. Give 'purpose' when you want to run the call yourself end to end; you will be handed the conversation and can talk until it is done. This dials a real person, so confirm with ${owner} first.`,
          inputSchema: z.object({
            to: z.string().min(1).describe("The number to call."),
            greeting: z
              .string()
              .max(500)
              .optional()
              .describe("The first thing spoken when they answer."),
            purpose: z
              .string()
              .max(2000)
              .optional()
              .describe(
                "What the call is for, written as instructions to whoever runs it. Providing this hands the whole call to a scripted voice agent - cheaper and lower latency than routing every turn back to you, and the right choice for a simple errand. Omit it to take the call yourself.",
              ),
          }),
          async execute({ to, greeting, purpose }) {
            const placed = await runTool(
              placePhoneCall({
                to,
                ...(greeting === undefined ? {} : { greeting }),
                ...(purpose === undefined ? {} : { systemPrompt: purpose }),
              }),
            );
            return {
              calling: to,
              callId: placed.callId,
              mode: purpose === undefined ? "you answer each turn" : "scripted",
            };
          },
        }),

        verification_code: defineTool({
          approval: ownerOnly,
          description: `Read the verification codes texted to your own phone number. Use this to finish a 2FA or sign-in step on an account of YOUR own - for example while setting up a service on your computer. Returns the recent inbound texts so you can read the code yourself. Note many banks, Google, and Apple reject this kind of number for verification, so it will not work everywhere; it is reliable for ordinary services. Never use it to get into an account belonging to ${owner} - ask him instead.`,
          inputSchema: z.object({
            from: z
              .string()
              .max(100)
              .optional()
              .describe(
                "Only return texts whose sender contains this, e.g. a short code or a service name.",
              ),
            limit: z
              .number()
              .int()
              .min(1)
              .max(20)
              .default(5)
              .describe("How many recent inbound texts to look at."),
          }),
          async execute({ from, limit }) {
            const since = new Date(Date.now() - CODE_WINDOW_MS).toISOString();
            const messages = await runTool(phoneInbox({ limit, since }));
            const filtered =
              from === undefined
                ? messages
                : messages.filter((message) =>
                    message.from_.toLowerCase().includes(from.toLowerCase()),
                  );

            if (filtered.length === 0) {
              return {
                found: false as const,
                note: "No verification text has arrived in the last 15 minutes. Trigger the code, wait a few seconds, then check again.",
              };
            }

            return {
              found: true as const,
              messages: filtered.map((message) => ({
                from: message.from_,
                body: message.body,
                receivedAt: message.receivedAt,
                // A best guess only — the model should read `body` and decide,
                // since a text can carry both a code and an order number.
                likelyCode: CODE_PATTERN.exec(message.body)?.[1].replace(/[\s-]/g, "") ?? null,
              })),
            };
          },
        }),
      };
    },
  },
});
