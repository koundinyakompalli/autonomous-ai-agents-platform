import { describe, expect, it } from "vitest";
import { renderDraftMarkdown } from "./renderers.js";
import type { SpecFactoryDraftBundle } from "./types.js";

function validBundle(): SpecFactoryDraftBundle {
  return {
    sourceJiraKey: "CPDEV-22410",
    loeHours: 38,
    epic: {
      summary: "Automate enrollment sync validation for Client A",
      description: "Client A needs repeatable validation for enrollment sync rules.",
      businessContext: ["Louise estimated this as a cross-repo delivery item."],
      acceptanceCriteria: ["Generated child tickets cover each repo-specific change."],
      assumptions: ["Default branch is used unless the source ticket names a branch."],
      dependencies: ["Config rollout depends on backend validation behavior."],
    },
    childTickets: [
      {
        repoName: "core-app",
        summary: "[core-app] Add enrollment sync validation",
        overview: "Implement backend validation for enrollment sync rules.",
        acceptanceCriteria: [
          "The service rejects enrollment sync payloads that violate Client A rules.",
          "Existing enrollment sync behavior remains unchanged for other clients.",
        ],
        technicalDetails: {
          repo: "core-app",
          branch: "master",
          targetFiles: ["service/EnrollmentSyncValidator.java"],
          implementationNotes: ["Use the existing validation service entry point."],
        },
        outOfScope: ["Do not change UI behavior."],
        testingNotes: ["Run enrollment sync unit tests."],
        loeHours: 20,
        sourceEvidenceRefs: ["attachment:loe-estimate.md"],
      },
    ],
    evidenceSummary: ["loe-estimate.md indicates 38 total hours."],
    warnings: [],
  };
}

describe("renderDraftMarkdown", () => {
  it("renders epic and child sections without empty separators", () => {
    const markdown = renderDraftMarkdown(validBundle());

    expect(markdown).toContain("# Epic: Automate enrollment sync validation for Client A");
    expect(markdown).toContain("# Child Story 1: core-app");
    expect(markdown).toContain("Repo: core-app");
    expect(markdown).not.toContain("---\n\n---");
    expect(markdown).not.toMatch(/---\n\s*\n---/);
  });
});
