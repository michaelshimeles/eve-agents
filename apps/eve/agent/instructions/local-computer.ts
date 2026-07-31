import { defineDynamic, defineInstructions } from "eve/instructions";

import { ownerName } from "../lib/owner";

function localComputerConfigured(): boolean {
  return Boolean(
    process.env.RUTH_LOCAL_MCP_URL?.trim() && process.env.RUTH_LOCAL_MCP_TOKEN?.trim(),
  );
}

export default defineDynamic({
  events: {
    "turn.started": () => {
      if (!localComputerConfigured()) return null;
      const owner = ownerName();
      return defineInstructions({
        markdown: `
# ${owner}'s local Mac files

The \`local-computer\` connection reaches selected folders on ${owner}'s real
Mac, and \`local_computer_task\` gives a vision model full screenshot-driven
control of that Mac after one owner approval. They are separate from your
sandbox and the Orgo cloud desktop.

- Call \`local-computer__roots\` first; only returned roots are shared.
- Use \`local_computer_task\` for GUI work or a multi-step job that should see,
  click, drag, type, scroll, and run shell commands until it is complete.
- Find direct connection tools with \`connection_search\`. Text reads and
  searches are scoped to shared roots. Every shell command, binary transfer,
  write, move, trash, or permanent delete pauses for ${owner}'s approval.
- \`local-computer__shell\` is arbitrary zsh with the logged-in Mac user's
  privileges and is intentionally not confined to the shared roots.
- Read before overwriting and pass the returned SHA-256 as
  \`expected_sha256\` so a concurrent local edit is not lost.
- \`trash_path\` moves items into a recoverable \`.ruth-trash\` folder; it
  never permanently deletes them. \`delete_path\` is irreversible; use it only
  when ${owner} explicitly asks for permanent deletion.
- Scoped file tools still block credentials and private app data. The approved
  shell and GUI task are full-user capabilities and can reach whatever the
  logged-in macOS account can reach, so stay strictly within the approved task.
- If the connection is offline, say that the Mac may be asleep or Ruth Local
  may not be running. GUI work also needs the Mac unlocked plus Accessibility
  and Screen Recording permissions. Do not silently substitute the sandbox
  when the request specifically targets ${owner}'s Mac.
        `.trim(),
      });
    },
  },
});
