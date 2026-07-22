import { defineSchedule } from "eve/schedules";

// Nightly "dreaming" pass over long-term memory (Supermemory): merge
// duplicates, resolve contradictions, promote recurring signals to permanent,
// and prune stale one-off context. Task mode: runs to completion with no
// channel delivery; the work happens through the memory tools. Cron is UTC on
// Vercel, so 08:15 is ~4am in Toronto.
export default defineSchedule({
  cron: "15 8 * * *",
  markdown: `
Nightly memory consolidation. Review your long-term memory about Micky and
tidy it. Work only through list_memories, remember, and forget; do not
message anyone.

1. Load everything with list_memories.
2. Merge duplicates: when several entries say the same thing, save one entry
   with the best phrasing (entity-centric, e.g. "Micky prefers window seats")
   using remember, then forget the redundant ones. Skip this when entries
   only look similar but carry distinct details.
3. Resolve contradictions: when two entries conflict, keep the more recent
   one (updatedAt) and forget the outdated one. If recency is unclear, keep
   both.
4. Promote stable patterns: a non-permanent fact that keeps showing up or is
   clearly durable (routines, relationships, strong preferences, ongoing
   projects) becomes one permanent entry (remember with permanent: true);
   forget the transient duplicates it replaces.
5. Prune: forget one-off context that is clearly spent (past events long
   over, short-lived states, completed errands). Keep anything with lasting
   value.

Be conservative: when in doubt, keep the memory. Never forget a permanent
entry unless it is directly superseded by a merged or newer version you just
saved. Aim for a small, high-signal set of edits, not a rewrite.
`.trim(),
});
