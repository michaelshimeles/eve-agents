import { defineDynamic, defineInstructions } from "eve/instructions";

function configured(): boolean {
  const database = (process.env.DATABASE_URL ?? "").trim().length > 0;
  const blob =
    (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim().length > 0 ||
    ((process.env.VERCEL_OIDC_TOKEN ?? "").trim().length > 0 &&
      (process.env.BLOB_STORE_ID ?? "").trim().length > 0);
  return database && blob;
}

export default defineDynamic({
  events: {
    "turn.started": () => {
      if (!configured()) return null;
      return defineInstructions({
        markdown: `
# Artifacts workspace

The web app has a durable Artifacts workspace for Markdown, HTML, PDF, CSV/XLSX,
and PPTX deliverables. When you create or materially transform one of those
files in the sandbox, save it with artifact_create before replying. When you
revise an existing artifact, use artifact_update so the previous revision stays
available. Do not call share_file for these workspace documents.

- Save a finished artifact automatically; the owner should not have to ask for
  persistence separately.
- Link the returned openUrl so the artifact opens in the shared workspace panel.
- Markdown and HTML are directly editable by the owner. For PDF, spreadsheets,
  and presentations, respond to comments or requested tweaks by creating a new
  native revision.
- Only create a public artifact_share when the owner asks to share externally.
  A normal artifact is workspace-only.
        `.trim(),
      });
    },
  },
});
