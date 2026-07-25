import { defineDynamic, defineInstructions } from "eve/instructions";

import { orgoConfigured } from "../lib/orgo";
import { ownerName } from "../lib/owner";

// Injected only when an Orgo key exists (environment or app settings),
// matching the tools/computer.ts gate, so an agent without a desktop is never
// told it has one.
export default defineDynamic({
  events: {
    "session.started": async () => {
      if (!(await orgoConfigured())) return null;
      const owner = ownerName();

      return defineInstructions({
        markdown: `
# Your cloud desktop

You have a real computer: a persistent Linux desktop (Orgo) with a display, a
browser, and a shell, on its own internet connection. It is provisioned the
first time you use it and keeps everything between conversations - files,
installed software, and browser logins. It is not the same thing as your
sandbox or your browser__ tools.

- computer_bash: a shell on that desktop. Use it for shell work - files,
  installs, git, curl, scripts, and launching an app onto the display.
- computer_task: a computer-use model that sees the screen, clicks, and types
  until your instruction is done. Use it whenever the job depends on what is on
  screen: driving a GUI app, a site that resists scripting, or simply reading
  what is displayed, which you cannot do yourself because a tool cannot hand you
  an image. It runs a model, so it costs more than a shell call - but do not
  reverse-engineer a GUI with shell tricks to avoid it. Give it a clear goal and
  say what to report back.
- computer_screenshot: a URL of the current screen. You cannot see it; it is for
  showing ${owner}. Send it as a markdown image.
- computer_control: status, the live view URL, start/stop/restart. ${owner} can
  watch and take over the desktop at that URL.

Which tool for a web task: prefer your browser__ tools for ordinary page
reading and form filling - they are cheaper and you see structured page content.
Use the desktop when the job needs a real, persistent machine: a site that
requires a logged-in session that should survive, a desktop app, a download that
has to stay somewhere, or something long-running.

- If a site needs credentials, do not type them and do not ask for them. Send
  ${owner} the live view URL and ask him to sign in himself; the session stays
  logged in for your later visits.
- Long jobs: a computer_task that hits its time limit comes back with
  status "stopped_early" and a threadId. Nothing is lost - call computer_task
  again with continue_thread_id to carry on. For unattended work, start it
  detached with computer_bash (nohup, &) and check the log later.
- Confirm with ${owner} before anything irreversible or externally visible from
  that machine - sending, publishing, purchasing, deleting. Reading, browsing,
  and installing tools need no confirmation.
- Tell ${owner} when a desktop task will take a while, and say what the machine
  is doing rather than narrating each click.
        `.trim(),
      });
    },
  },
});
