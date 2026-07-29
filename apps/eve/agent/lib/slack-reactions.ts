import { settingsStore } from "./settings-db";

// Emoji-reaction triggers for the Slack channel: the owner writes rules under
// Manage -> Slack pairing an emoji with an instruction, and reacting with that
// emoji starts a turn. There are deliberately no built-in emoji behaviors —
// with no rules configured, agent/channels/slack.ts's onEvent does nothing.
//
// Stored as one JSON array in the app_settings row `slack_reaction_rules`
// (settings-db.ts), so this needs DATABASE_URL. Like agent/lib/delivery.ts,
// this is a typed accessor over the shared settings store rather than a
// Neon-backed store of its own: it writes no SQL, so it stays plain
// TypeScript instead of moving onto the Effect stack.

export const SLACK_REACTION_AUDIENCES = ["owner", "anyone"] as const;
export type SlackReactionAudience = (typeof SLACK_REACTION_AUDIENCES)[number];

export interface SlackReactionRule {
  /** Slack emoji name, normalized: lowercase, no colons, no skin-tone suffix. */
  emoji: string;
  /** Free-text instruction handed to the agent when the reaction fires. */
  prompt: string;
  /** Who may trigger it. */
  audience: SlackReactionAudience;
}

const SETTING = "slack_reaction_rules";

/** Keeps the settings row small and the editor manageable. */
const MAX_RULES = 25;

/** One rule must not be able to blow out a turn's context. */
const MAX_PROMPT_CHARS = 2000;

/**
 * Canonical form of a Slack emoji name.
 *
 * Slack sends `event.reaction` without colons (`eyes`), and skin-tone variants
 * arrive suffixed (`+1::skin-tone-3`) — the suffix is dropped so one rule
 * covers every tone. Owner-typed values may carry the colons they see in
 * Slack (`:eyes:`), so those are stripped too. Custom workspace emoji are
 * ordinary names and need no special handling.
 */
export function normalizeEmojiName(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/^:+/, "").replace(/:+$/, "");
  return trimmed.split("::")[0] ?? "";
}

function isAudience(value: unknown): value is SlackReactionAudience {
  return typeof value === "string" && (SLACK_REACTION_AUDIENCES as readonly string[]).includes(value);
}

/**
 * Validates and normalizes a rule list, throwing an owner-readable message on
 * the first problem so the API route can surface which rule is wrong.
 *
 * Runs on write and again on read: the row is plaintext in a database other
 * code touches, so parse, don't trust.
 */
export function validateSlackReactionRules(input: unknown): SlackReactionRule[] {
  if (!Array.isArray(input)) throw new Error("Reaction rules must be a list.");
  if (input.length > MAX_RULES) {
    throw new Error(`That is more than ${MAX_RULES} reaction rules.`);
  }

  const rules: SlackReactionRule[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Every reaction rule must be an object.");
    }
    const record = entry as Record<string, unknown>;

    const emoji = normalizeEmojiName(typeof record.emoji === "string" ? record.emoji : "");
    if (emoji.length === 0) throw new Error("Every reaction rule needs an emoji.");
    if (seen.has(emoji)) {
      // Rejected rather than last-wins: silently dropping one of two rules for
      // the same emoji makes "why did my rule stop working" hard to answer.
      throw new Error(`There is more than one rule for :${emoji}:.`);
    }

    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (prompt.length === 0) throw new Error(`The rule for :${emoji}: needs an instruction.`);
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(
        `The instruction for :${emoji}: is longer than ${MAX_PROMPT_CHARS} characters.`,
      );
    }

    // No default: an unreadable audience must fail closed rather than silently
    // opening a rule to the whole workspace.
    if (!isAudience(record.audience)) {
      throw new Error(`The rule for :${emoji}: must be for the owner or for anyone.`);
    }

    seen.add(emoji);
    rules.push({ emoji, prompt, audience: record.audience });
  }
  return rules;
}

/**
 * The configured rules, or an empty list when none are set, there is no
 * database, or the stored row is unreadable.
 *
 * Reads fresh for the same reason getDeliveryTarget does: a reaction moments
 * after the owner edits a rule must honor the new one, and reactions are far
 * too infrequent for the stale-while-revalidate path to have warmed anyway.
 */
export async function listSlackReactionRules(): Promise<SlackReactionRule[]> {
  const raw = await settingsStore.getFresh(SETTING);
  if (raw === null) return [];
  try {
    return validateSlackReactionRules(JSON.parse(raw));
  } catch (error) {
    // Fail closed: a corrupted setting disables reaction triggers rather than
    // firing something the owner did not write.
    console.error("Slack reaction rules are unreadable; treating as none configured.", error);
    return [];
  }
}

/** Replaces the whole rule list. Throws when a rule is invalid. */
export async function setSlackReactionRules(rules: unknown): Promise<SlackReactionRule[]> {
  const validated = validateSlackReactionRules(rules);
  if (validated.length === 0) {
    // Storing nothing keeps a fresh database and a cleared list
    // indistinguishable, matching how delivery.ts drops its default.
    await settingsStore.delete(SETTING);
    return validated;
  }
  await settingsStore.set(SETTING, JSON.stringify(validated));
  return validated;
}

/** The rule for an already-normalized emoji name, or null when none matches. */
export function findSlackReactionRule(
  rules: readonly SlackReactionRule[],
  emoji: string,
): SlackReactionRule | null {
  return rules.find((rule) => rule.emoji === emoji) ?? null;
}
