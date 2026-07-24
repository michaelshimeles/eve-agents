import { defineDynamic, defineInstructions } from "eve/instructions";
import { skillStore } from "../lib/skill-store";
import { withTimeout } from "../lib/with-timeout";

// Same first-reply guard as the memory profile: a cold cache blocks the
// session's first model call on the Blob fetch, so cap the wait.
const SKILLS_TIMEOUT_MS = 2000;

// Inlines every chat-created skill (saved via the create_skill tool) into the
// session's instructions. Serving them as real eve skills would materialize
// files into the session sandbox, which forces a sandbox VM open before the
// first reply; the saved procedures are short, so inlining them is cheaper
// than a sandbox round-trip. Resolving on session.started means a skill
// created mid-conversation applies from the next session onward.
export default defineDynamic({
  events: {
    "session.started": async () => {
      let skills;
      try {
        skills = await withTimeout(skillStore.list(), SKILLS_TIMEOUT_MS, "Skill list");
      } catch {
        return null;
      }
      if (skills.length === 0) return null;

      const sections = skills.map(
        (skill) => `### ${skill.name}\nWhen to use: ${skill.description}\n\n${skill.markdown}`,
      );

      return defineInstructions({
        markdown: `
## Saved skills

The user has saved these reusable procedures. When a request matches a
skill's "When to use" line, follow that skill's steps.

${sections.join("\n\n")}
        `.trim(),
      });
    },
  },
});
