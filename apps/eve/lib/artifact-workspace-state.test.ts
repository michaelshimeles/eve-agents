import { describe, expect, it } from "vitest";

import { artifactTargetTransition } from "./artifact-workspace-state";

describe("artifact workspace navigation", () => {
  it("opens a changed direct-link target in all-artifact scope", () => {
    expect(artifactTargetTransition("artifact-a", "artifact-b")).toEqual({
      scope: "all",
      selectedId: "artifact-b",
    });
  });

  it("returns to thread scope when navigation clears the artifact target", () => {
    expect(artifactTargetTransition("artifact-a", null)).toEqual({
      scope: "thread",
      selectedId: null,
    });
  });

  it("does not change scope when the parent echoes a local selection", () => {
    expect(artifactTargetTransition("artifact-b", "artifact-b")).toBeNull();
  });
});
