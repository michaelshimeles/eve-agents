import { describe, expect, it } from "vitest";

import {
  defaultIMessageFeatureFlags,
  IMESSAGE_FEATURE_FLAGS,
  IMESSAGE_RICH_EXPERIENCE_FLAGS,
} from "./imessage-feature-flags";

describe("iMessage feature flags", () => {
  it("defines a default for every rollout switch", () => {
    const defaults = defaultIMessageFeatureFlags();
    expect(Object.keys(defaults).sort()).toEqual([...IMESSAGE_FEATURE_FLAGS].sort());
  });

  it("starts durable ingest on while rich outbound capabilities remain canaried", () => {
    const defaults = defaultIMessageFeatureFlags();
    expect(defaults.imessage_durable_router).toBe(true);
    expect(defaults.imessage_passive_rich_ingest).toBe(true);
    expect(defaults.imessage_location).toBe(false);
    expect(defaults.imessage_group_admin).toBe(false);
  });

  it("keeps the one-switch rich experience separate from sensitive controls", () => {
    expect(IMESSAGE_RICH_EXPERIENCE_FLAGS).toEqual([
      "imessage_native_markdown",
      "imessage_rich_media",
      "imessage_voice",
      "imessage_streaming_edits",
      "imessage_replies_reactions",
      "imessage_polls",
      "imessage_universal_apps",
    ]);
    expect(
      IMESSAGE_RICH_EXPERIENCE_FLAGS.every((flag) =>
        IMESSAGE_FEATURE_FLAGS.includes(flag),
      ),
    ).toBe(true);
    expect(IMESSAGE_RICH_EXPERIENCE_FLAGS).not.toContain("imessage_group_admin");
    expect(IMESSAGE_RICH_EXPERIENCE_FLAGS).not.toContain("imessage_focus_notify");
    expect(IMESSAGE_RICH_EXPERIENCE_FLAGS).not.toContain("imessage_location");
  });
});
