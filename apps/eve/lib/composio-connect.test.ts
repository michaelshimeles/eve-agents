import { describe, expect, it } from "vitest";

import {
  FALLBACK_TOOLKITS,
  mergeComposioToolkitCatalogs,
  parseComposioToolkitCatalog,
  validateComposioToolkitCatalog,
} from "./composio-connect";

describe("parseComposioToolkitCatalog", () => {
  it("extracts and sorts the structured toolkit catalog", () => {
    expect(
      parseComposioToolkitCatalog([
        { slug: "slack", name: "Slack", tools: [{ slug: "SLACK_SEND_MESSAGE" }] },
        { slug: "acme", name: "Acme & Sons", category: "developer tools" },
      ]),
    ).toEqual([
      { slug: "acme", name: "Acme & Sons" },
      { slug: "slack", name: "Slack" },
    ]);
  });

  it("rejects a malformed entry instead of silently omitting it", () => {
    expect(() =>
      parseComposioToolkitCatalog([
        { slug: "figma", name: "Figma" },
        { slug: "changed-upstream-shape", label: "Changed upstream shape" },
      ]),
    ).toThrow("entry 1 was invalid");
  });

  it("rejects duplicate slugs instead of masking catalog corruption", () => {
    expect(() =>
      parseComposioToolkitCatalog([
        { slug: "figma", name: "Figma" },
        { slug: "figma", name: "Figma duplicate" },
      ]),
    ).toThrow("duplicate slug figma");
  });
});

describe("FALLBACK_TOOLKITS", () => {
  it("retains the full catalog snapshot for cold-start outages", () => {
    expect(FALLBACK_TOOLKITS.length).toBeGreaterThanOrEqual(1_000);
    expect(new Set(FALLBACK_TOOLKITS.map(({ slug }) => slug)).size).toBe(
      FALLBACK_TOOLKITS.length,
    );
    expect(FALLBACK_TOOLKITS).toContainEqual({ slug: "figma", name: "Figma" });
  });

  it("allows normal catalog drift but rejects a substantially partial parse", () => {
    expect(() => validateComposioToolkitCatalog(FALLBACK_TOOLKITS.slice(1))).not.toThrow();
    expect(() => validateComposioToolkitCatalog(FALLBACK_TOOLKITS.slice(0, 100))).toThrow(
      "catalog was incomplete",
    );
  });

  it("keeps snapshot slugs while preferring current names and additions", () => {
    expect(
      mergeComposioToolkitCatalogs(FALLBACK_TOOLKITS, [
        { slug: "figma", name: "Figma Current" },
        { slug: "new_toolkit", name: "New Toolkit" },
      ]),
    ).toEqual(
      expect.arrayContaining([
        { slug: "figma", name: "Figma Current" },
        { slug: "new_toolkit", name: "New Toolkit" },
      ]),
    );
  });
});
