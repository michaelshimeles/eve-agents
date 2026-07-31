import { connectSlackCredentials } from "@vercel/connect/eve";
import type {
  SlackEvent,
  SlackInboundEventContext,
  SlackInboundMessageContext,
  SlackMessage,
} from "eve/channels/slack";
import { slackChannel } from "eve/channels/slack";

import { rememberOwnerSlackChannel } from "../lib/delivery";
import { isOwnerSlackUser, ownerSlackUserId, slackConnectClientId } from "../lib/slack";
import {
  commandText,
  isDirectMessageChannel,
  reactedMessageRef,
  resolveReaction,
  UNRESOLVED,
  type ResolvedReaction,
} from "../lib/slack-events";
import { findSlackReactionRule, listSlackReactionRules, normalizeEmojiName } from "../lib/slack-reactions";

// Slack, via Vercel Connect. Connect holds the workspace's bot token and
// verifies inbound webhooks, so there is no SLACK_BOT_TOKEN or
// SLACK_SIGNING_SECRET here; SLACK_CONNECT_CLIENT_ID names the Connect client
// and its trigger must be attached to this route (see AGENTS.md). Mounted at
// POST /eve/v1/slack.
//
// This is a team surface. The owner (SLACK_OWNER_USER_ID) talks to the agent
// with full capability; everyone else is admitted as a "guest", which is the
// label agent/lib/owner-gate.ts already denies owner-only tools on. No new
// security boundary is introduced here — the channel only reports who is
// speaking, and the framework enforces it before a tool executes.
//
// Emoji-reaction triggers are entirely owner-configured (Manage -> Slack,
// agent/lib/slack-reactions.ts). There are no built-in emoji behaviors: with
// no rules stored, onEvent does nothing.

/** Typed in a thread, starts the conversation over. */
const RESET_COMMAND = "/new";

/** How much of a reacted message to quote into the turn. */
const MAX_QUOTED_CHARS = 4000;

/**
 * Thread replies fetched when resolving a reacted message. Slack caps
 * `conversations.replies` at 1000; 200 keeps the payload small while still
 * covering any thread a person is realistically reacting inside.
 */
const REPLY_FETCH_LIMIT = 200;

/** Session auth for one Slack actor. */
function slackAuth(input: { userId: string; channelId: string; isDirectMessage: boolean }) {
  return {
    authenticator: "slack",
    principalType: "user",
    principalId: `slack:${input.userId}`,
    attributes: {
      user_id: input.userId,
      channel_id: input.channelId,
      chat: input.isDirectMessage ? "dm" : "channel",
      // The gate agent/lib/owner-gate.ts reads. An unset SLACK_OWNER_USER_ID
      // makes everyone a guest, which is the safe direction.
      role: isOwnerSlackUser(input.userId) ? "owner" : "guest",
    },
  };
}

function clip(text: string): string {
  return text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS)}\n… (truncated)` : text;
}

/** The turn text for a fired reaction rule. */
function reactionMessage(input: {
  prompt: string;
  emoji: string;
  reactorId: string;
  channelId: string;
  message: ResolvedReaction;
}): string {
  const text = input.message.text;
  const quoted =
    text !== null && text.trim().length > 0
      ? ["```", clip(text), "```"]
      : ["(Slack did not return the message's text — say so rather than guessing at it.)"];
  const author = input.message.user !== null ? ` posted by <@${input.message.user}>` : "";
  return [
    input.prompt,
    "",
    `The message you're acting on${author} in <#${input.channelId}>:`,
    ...quoted,
    "",
    `This fired because <@${input.reactorId}> reacted with :${input.emoji}: — nobody addressed you directly, so lead with what this is about.`,
  ].join("\n");
}

/**
 * Reaction triggers. Every check returns silently: an unmatched reaction is
 * the overwhelmingly common case in any busy workspace and is not worth a log
 * line.
 *
 * There is deliberately no "did the agent react to this itself" guard. It has
 * no tool for adding a reaction, so it cannot trigger a rule; the cheap way to
 * learn its own bot user id (`auth.test`) would otherwise cost an API call on
 * every reaction in the workspace.
 */
async function handleReaction(ctx: SlackInboundEventContext, event: SlackEvent): Promise<void> {
  const emoji = normalizeEmojiName(typeof event.reaction === "string" ? event.reaction : "");
  if (emoji.length === 0) return;

  const reactorId = typeof event.user === "string" ? event.user : "";
  if (reactorId.length === 0) return;

  const rule = findSlackReactionRule(await listSlackReactionRules(), emoji);
  if (rule === null) return;
  // An "anyone" rule still dispatches as a guest turn for non-owners, so
  // owner-gate keeps blocking the sensitive tools.
  if (rule.audience === "owner" && !isOwnerSlackUser(reactorId)) return;

  const ref = reactedMessageRef(event);
  if (ref === null) return;

  // Best-effort: a lookup miss still leaves a usable turn, which beats
  // dropping a trigger the owner deliberately configured.
  let resolved: ResolvedReaction = UNRESOLVED;
  try {
    const response = await ctx.slack.request("conversations.replies", {
      channel: ref.channelId,
      ts: ref.ts,
      limit: REPLY_FETCH_LIMIT,
      inclusive: true,
    });
    if (response.ok) {
      resolved = resolveReaction(response, ref.ts);
    } else {
      console.error(`Slack reaction lookup failed: ${String(response.error)}.`);
    }
  } catch (error) {
    console.error("Slack reaction lookup failed.", error);
  }

  await ctx.receive({
    message: reactionMessage({
      prompt: rule.prompt,
      emoji,
      reactorId,
      channelId: ref.channelId,
      message: resolved,
    }),
    // Anchoring on the resolved thread root keeps the reply where the reaction
    // happened. When the root is unknown the anchor is omitted rather than
    // guessed at with the reacted message's own ts — that ts is a reply's in a
    // thread, which would land the turn under the wrong anchor. eve anchors an
    // unanchored session on its own first post instead.
    target:
      resolved.threadTs !== null
        ? { channelId: ref.channelId, threadTs: resolved.threadTs }
        : { channelId: ref.channelId },
    auth: slackAuth({
      userId: reactorId,
      channelId: ref.channelId,
      isDirectMessage: isDirectMessageChannel(ref.channelId),
    }),
  });
}

export default slackChannel({
  credentials: connectSlackCredentials(slackConnectClientId()),

  // Repeated mentions inject only what is new, rather than replaying the whole
  // thread every time.
  threadContext: { since: "last-agent-reply" },

  async onMessage(ctx: SlackInboundMessageContext, message: SlackMessage) {
    const author = message.author;
    // eve drops the installed app's own messages before this runs, so this
    // covers other bots.
    if (author === undefined || author.isBot) return null;

    const isDirectMessage = message.raw.channel_type === "im";

    // Admission is checked before the reset command on purpose: /new must not
    // let someone retire a session — or make the agent speak — in a thread it
    // was never invited into.
    const admitted = isDirectMessage || ctx.isBotMentioned() || (await ctx.isSubscribed());
    if (!admitted) return null;

    if (commandText(message.text) === RESET_COMMAND) {
      await ctx.reset({ reason: "Slack user requested /new" });
      await ctx.thread.post("Started a fresh conversation.");
      // Returning null consumes the command instead of delivering it as the
      // first turn of the fresh session.
      return null;
    }

    // Replaces the in-flight turn with this message rather than racing it.
    // Both "accepted" and "no_active_turn" are successes, so neither branches.
    await ctx.cancel();

    if (isDirectMessage && isOwnerSlackUser(author.userId)) {
      // So web-created reminders and triggers can deliver to Slack when the
      // owner picks it in Manage.
      await rememberOwnerSlackChannel(message.channelId);
    }

    return {
      auth: slackAuth({
        userId: author.userId,
        channelId: message.channelId,
        isDirectMessage,
      }),
    };
  },

  async onEvent(ctx: SlackInboundEventContext, event: SlackEvent) {
    // reaction_removed is not subscribed and is not handled.
    if (event.type !== "reaction_added") return;
    await handleReaction(ctx, event);
  },

  events: {
    // A sign-in challenge is a credential: whoever completes it binds their
    // identity to the session's connection. Deliver it to the person who
    // triggered it, never into the shared channel.
    //
    // Proactive turns (a fired reminder, a webhook) carry app or webhook auth,
    // so they have no triggering Slack user. Those run on the owner's behalf,
    // so the challenge goes to the owner — otherwise the sign-in link is lost
    // and the turn parks forever with nobody told why.
    async "authorization.required"(eventData, channel) {
      const userId = channel.state.triggeringUserId ?? ownerSlackUserId();
      const url = eventData.authorization?.url;
      if (userId === null || userId === undefined || url === undefined) {
        // Nowhere private to send a credential. Worth a log: the turn is about
        // to stall on an authorization nobody can complete.
        console.error(
          "Slack authorization challenge undeliverable: no triggering user and no SLACK_OWNER_USER_ID.",
        );
        return;
      }
      await channel.postDirectMessage(userId, `Sign in to continue: ${url}`);
    },
  },
});
