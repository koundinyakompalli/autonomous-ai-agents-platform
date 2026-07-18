import { describe, expect, it } from "vitest";
import { validateDraftBundle } from "./draft-validator.js";
import type { SpecFactoryDraftBundle } from "./types.js";

function validBundle(
  overrides: Partial<SpecFactoryDraftBundle> = {},
): SpecFactoryDraftBundle {
  return {
    sourceJiraKey: "CPDEV-22410",
    loeHours: 38,
    epic: {
      summary: "Automate enrollment sync validation for Client A",
      description:
        "Client A needs repeatable validation for enrollment sync rules.",
      businessContext: ["Louise estimated this as a cross-repo delivery item."],
      acceptanceCriteria: [
        "Generated child tickets cover each repo-specific change.",
      ],
      assumptions: [
        "Default branch is used unless the source ticket names a branch.",
      ],
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
          implementationNotes: [
            "Use the existing validation service entry point.",
          ],
        },
        outOfScope: ["Do not change UI behavior."],
        testingNotes: ["Run enrollment sync unit tests."],
        loeHours: 20,
        sourceEvidenceRefs: ["attachment:loe-estimate.md"],
      },
    ],
    evidenceSummary: ["loe-estimate.md indicates 38 total hours."],
    warnings: [],
    ...overrides,
  };
}

describe("validateDraftBundle", () => {
  it("accepts a OneShot-ready child ticket with repo and acceptance criteria", () => {
    const result = validateDraftBundle(validBundle());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    if (!result.valid) {
      throw new Error("Expected draft bundle to be valid");
    }
    expect(result.normalized.childTickets[0].technicalDetails.repo).toBe(
      "core-app",
    );
    expect(result.normalized.epic.acceptanceCriteria[0]).toMatch(
      /^Scenario:[\s\S]*^Given [\s\S]*^When [\s\S]*^Then /m,
    );
    expect(result.normalized.childTickets[0].acceptanceCriteria[0]).toMatch(
      /^Scenario:[\s\S]*^Given [\s\S]*^When [\s\S]*^Then /m,
    );
  });

  it("rejects child tickets without a repo directive", () => {
    const bundle = validBundle({
      childTickets: [
        {
          ...validBundle().childTickets[0],
          technicalDetails: {
            ...validBundle().childTickets[0].technicalDetails,
            repo: "",
          },
        },
      ],
    });

    const result = validateDraftBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "childTickets[0].technicalDetails.repo is required",
    );
  });

  it("rejects child tickets with fewer than two acceptance criteria", () => {
    const bundle = validBundle({
      childTickets: [
        {
          ...validBundle().childTickets[0],
          acceptanceCriteria: ["Only one criterion"],
        },
      ],
    });

    const result = validateDraftBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "childTickets[0].acceptanceCriteria must contain at least 2 items",
    );
  });

  it("allows multiple modular child stories for the same repo", () => {
    const firstChild = validBundle().childTickets[0];
    const bundle = validBundle({
      childTickets: [
        firstChild,
        {
          ...firstChild,
          repoName: "CORE-APP",
          summary: "[CORE-APP] Duplicate enrollment sync validation",
        },
      ],
    });

    const result = validateDraftBundle(bundle);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).not.toContain(
      "childTickets[1].repoName duplicates another child ticket",
    );
  });

  it("allows duplicate repo names for Compose story-driven drafts without warning", () => {
    const firstChild = validBundle().childTickets[0];
    const bundle = validBundle({
      sourceJiraKey: "COMPOSE-51",
      childTickets: [
        firstChild,
        {
          ...firstChild,
          summary: "[core-app] Add appeal intake shell",
          overview: "Create the initial appeal intake workflow.",
        },
      ],
    });

    const result = validateDraftBundle(bundle);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).not.toContain(
      "childTickets[1].repoName duplicates another child ticket; allowed for Compose story-driven drafts",
    );
  });

  it("warns when repoName differs from the technical repo directive", () => {
    const bundle = validBundle({
      childTickets: [
        {
          ...validBundle().childTickets[0],
          repoName: "core-app-api",
        },
      ],
    });

    const result = validateDraftBundle(bundle);

    expect(result.valid).toBe(true);
    expect(result.warnings).toContain(
      "childTickets[0] repoName differs from technicalDetails.repo",
    );
  });

  it("does not expose a normalized draft bundle when schema parsing fails", () => {
    const input = { sourceJiraKey: "not-a-jira-key" };

    const result = validateDraftBundle(input);

    expect(result.valid).toBe(false);
    expect(result.normalized).toBeNull();
    if (result.valid) {
      throw new Error("Expected draft bundle to be invalid");
    }
    expect(result.raw).toBe(input);
  });
});
