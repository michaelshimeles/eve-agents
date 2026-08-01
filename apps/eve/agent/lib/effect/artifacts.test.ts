import { describe, expect, it } from "vitest";

import { inferArtifactKind } from "./artifacts";

describe("inferArtifactKind", () => {
  it("recognizes every first-class artifact format", () => {
    expect(inferArtifactKind("notes.md", "text/plain")).toBe("markdown");
    expect(inferArtifactKind("index.HTML", "application/octet-stream")).toBe("html");
    expect(inferArtifactKind("report.bin", "application/pdf")).toBe("pdf");
    expect(
      inferArtifactKind(
        "budget.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("spreadsheet");
    expect(inferArtifactKind("export.csv", "text/plain")).toBe("spreadsheet");
    expect(
      inferArtifactKind(
        "deck.pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe("presentation");
  });

  it("keeps unsupported uploads as generic files", () => {
    expect(inferArtifactKind("archive.zip", "application/zip")).toBe("file");
  });
});
