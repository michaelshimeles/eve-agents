import { afterEach, describe, expect, it, vi } from "vitest";

import {
  artifactChangeFromStreamEvent,
  artifactIdFromHref,
  loadArtifactDraft,
  loadArtifactShares,
} from "./artifact-client";

const artifactId = "7f0e1ba4-2f7f-4a22-8ed4-14ff6b5d4d55";
const versionId = "6c52d325-79eb-43ea-99f0-1f9056bea764";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifact client events", () => {
  it("extracts a committed artifact revision from the Eve stream", () => {
    expect(
      artifactChangeFromStreamEvent({
        type: "action.result",
        data: {
          status: "completed",
          sequence: 4,
          stepIndex: 1,
          turnId: "turn",
          result: {
            kind: "tool-result",
            callId: "call",
            toolName: "artifact_update",
            output: { artifactId, versionId, revision: 2 },
          },
        },
      }),
    ).toEqual({ artifactId, versionId });
  });

  it("ignores unrelated and failed tool results", () => {
    expect(
      artifactChangeFromStreamEvent({
        type: "action.result",
        data: {
          status: "failed",
          sequence: 4,
          stepIndex: 1,
          turnId: "turn",
          result: {
            kind: "tool-result",
            callId: "call",
            toolName: "artifact_update",
            isError: true,
            output: { artifactId, versionId },
          },
          error: { code: "failed", message: "failed" },
        },
      }),
    ).toBeNull();
  });
});

describe("artifact links", () => {
  it("recognizes same-origin workspace links", () => {
    expect(
      artifactIdFromHref(
        `/?artifact=${artifactId}&workspace=artifacts`,
        "https://ruth.example",
      ),
    ).toBe(artifactId);
  });

  it("does not intercept external or non-workspace links", () => {
    expect(
      artifactIdFromHref(
        `https://outside.example/?artifact=${artifactId}&workspace=artifacts`,
        "https://ruth.example",
      ),
    ).toBeNull();
    expect(
      artifactIdFromHref(`/?artifact=${artifactId}`, "https://ruth.example"),
    ).toBeNull();
  });
});

describe("mutable artifact state", () => {
  it("revalidates cached drafts and shares during an explicit refresh", async () => {
    let draftContent = "first draft";
    let shareId = "first-share";
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/draft")) {
          return Response.json({ draft: { content: draftContent } });
        }
        if (url.endsWith("/shares")) {
          return Response.json({
            shares: [
              {
                id: shareId,
                artifactId,
                versionId,
                expiresAt: "2026-08-05T00:00:00.000Z",
                revokedAt: null,
                createdAt: "2026-07-29T00:00:00.000Z",
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadArtifactDraft(artifactId)).resolves.toEqual({
      draft: { content: "first draft" },
    });
    await expect(loadArtifactShares(artifactId)).resolves.toMatchObject([
      { id: "first-share" },
    ]);

    draftContent = "newer draft from another tab";
    shareId = "new-share";

    await expect(loadArtifactDraft(artifactId, { fresh: true })).resolves.toEqual({
      draft: { content: "newer draft from another tab" },
    });
    await expect(
      loadArtifactShares(artifactId, { fresh: true }),
    ).resolves.toMatchObject([{ id: "new-share" }]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ cache: "no-store" });
    }
  });
});
