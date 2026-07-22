import { defineDynamic, defineSkill } from "eve/skills";
import { skillStore } from "../lib/skill-store";

// Serves every chat-created skill (saved via the create_skill tool) as a real
// loadable skill. Resolving on turn.started means a skill created in one turn
// is advertised from the next turn onward, in this and every future session.
export default defineDynamic({
  events: {
    "turn.started": async () => {
      let skills;
      try {
        skills = await skillStore.list();
      } catch {
        return null;
      }
      if (skills.length === 0) return null;

      return Object.fromEntries(
        skills.map((skill) => [
          skill.name,
          defineSkill({
            description: skill.description,
            markdown: skill.markdown,
          }),
        ]),
      );
    },
  },
});
