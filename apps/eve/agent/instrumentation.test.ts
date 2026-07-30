import { describe, expect, it } from "vitest";
import { resolveBraintrustParent } from "./instrumentation";

describe("resolveBraintrustParent", () => {
  it("uses a configured parent before the Marketplace project", () => {
    expect(
      resolveBraintrustParent(
        "ruth",
        "project_name:override",
        "marketplace-project",
      ),
    ).toBe("project_name:override");
  });

  it("uses the Marketplace project when the parent is blank", () => {
    expect(
      resolveBraintrustParent("ruth", "", "marketplace-project"),
    ).toBe("project_id:marketplace-project");
  });

  it("falls back to the agent-named project", () => {
    expect(resolveBraintrustParent("ruth", undefined, undefined)).toBe(
      "project_name:ruth",
    );
  });
});
