import { describe, expect, it } from "vitest";
import {
  contextProjectionToReadiness,
  mergeContextReadiness,
} from "./contextProjection.js";
import type {
  ComposeContextProjection,
  ComposeReadiness,
} from "./composeTypes.js";

function projection(
  overrides: Partial<ComposeContextProjection> = {},
): ComposeContextProjection {
  return {
    sessionId: 7,
    version: 8,
    artifactUri: null,
    structuredArtifactUri: null,
    summary: null,
    facts: [{ text: "A historical fact." }],
    openQuestions: [],
    conflicts: [],
    decisions: [],
    sourceIds: [],
    patchIds: [],
    committedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

const sessionReadiness: ComposeReadiness = {
  ready: true,
  openQuestions: [],
  summary: "Current product summary.",
  problem: "Current product problem.",
  solution: "Current product solution.",
};

describe("context projection readiness", () => {
  it("does not let a historical null summary erase session readiness", () => {
    expect(mergeContextReadiness(sessionReadiness, projection())).toBe(
      sessionReadiness,
    );
  });

  it("uses a committed context summary when one is available", () => {
    const merged = mergeContextReadiness(
      sessionReadiness,
      projection({
        summary: {
          objective: "Committed objective.",
          problemStatement: "Committed problem.",
          solution: "Committed solution.",
          businessRequirements: [],
          functionalRequirements: [],
          challenges: [],
          stories: [],
          recommendedNextActions: [],
        },
      }),
    );

    expect(merged).toMatchObject({
      summary: "Committed problem.",
      problem: "Committed problem.",
      solution: "Committed solution.",
    });
  });

  it("still projects a fallback when no session readiness exists", () => {
    expect(contextProjectionToReadiness(projection())).toMatchObject({
      summary: "A historical fact.",
      problem: "A historical fact.",
    });
  });
});
