import { skillStore } from "@/agent/lib/skill-store";
import { requireWebAuth } from "@/lib/web-auth";

// Saved skills (created in chat, stored in Vercel Blob) feed the composer's
// slash-command palette alongside the built-in commands.
export async function GET(request: Request): Promise<Response> {
  const denied = requireWebAuth(request);
  if (denied) return denied;
  try {
    const skills = await skillStore.list();
    return Response.json({
      commands: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
    });
  } catch {
    // Blob store unreachable (e.g. local dev without a token): palette just
    // shows the built-ins.
    return Response.json({ commands: [] });
  }
}
