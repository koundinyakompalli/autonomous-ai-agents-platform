import { describe, expect, it } from "vitest";
import {
  parseQualificationAssessment,
  MultiRepoSliceSchema,
  MultiRepoBriefSchema,
  MultiBranchRetrofitPlanSchema,
  MultiBranchRetrofitBriefSchema,
  RepoSelectionTypeSchema,
} from "./qualification.js";

const baseRepoSelection = {
  type: "profiled_repo" as const,
  selectedRepoIds: [1],
  candidateSummaries: [],
  repoReasoning: "matched profile",
};

describe("parseQualificationAssessment", () => {
  it("accepts qualification output without injected execution fields", () => {
    const assessment = parseQualificationAssessment({
      qualified: true,
      templateMatched: "cpdev_template",
      requirementsSummary: ["Implement the new member-search UI path."],
      acceptanceCriteriaPresent: false,
      blockingReasons: [],
      nonBlockingWarnings: [
        "Acceptance criteria are implied rather than explicit.",
      ],
      qualificationReasoning: "Ticket matches CPDEV template; AC implied.",
      repoSelection: baseRepoSelection,
    });

    expect(assessment.qualified).toBe(true);
    expect(assessment.templateMatched).toBe("cpdev_template");
    expect(assessment.repoSelection.type).toBe("profiled_repo");
    expect(assessment.repoSelection.selectedRepoIds).toEqual([1]);
    expect(assessment.repoId).toBeUndefined();
    expect(assessment.branchName).toBeUndefined();
    expect(assessment.baseCommitSha).toBeUndefined();
    expect(assessment.repoInspectionPerformed).toBe(false);
    expect(assessment.inspectedFiles).toEqual([]);
    expect(assessment.inspectionSummary).toBeUndefined();
  });

  it("normalizes placeholder deterministic fields to undefined", () => {
    const assessment = parseQualificationAssessment({
      qualified: true,
      templateMatched: "cpdev_template",
      repoId: 0,
      branchName: "   ",
      baseCommitSha: "",
      requirementsSummary: ["Implement the new member-search UI path."],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      qualificationReasoning: "OK",
      repoSelection: baseRepoSelection,
    });

    expect(assessment.repoId).toBeUndefined();
    expect(assessment.branchName).toBeUndefined();
    expect(assessment.baseCommitSha).toBeUndefined();
  });

  it("accepts retrofit qualification with retrofitContext", () => {
    const assessment = parseQualificationAssessment({
      qualified: true,
      templateMatched: "retrofit_template",
      requirementsSummary: ["Retrofit CPDEV-1234 from 4.1 to 3.17."],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      qualificationReasoning: "Complete retrofit block.",
      repoSelection: baseRepoSelection,
      retrofitContext: {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "medhok-monorepo-4.1",
        targetBranch: "medhok-monorepo-3.17",
      },
    });

    expect(assessment.templateMatched).toBe("retrofit_template");
    expect(assessment.retrofitContext?.sourceJiraKey).toBe("CPDEV-1234");
  });

  it("accepts multi_repo repoSelection type", () => {
    const assessment = parseQualificationAssessment({
      qualified: true,
      templateMatched: "cpdev_template",
      requirementsSummary: ["Implement across two repos."],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      qualificationReasoning: "Ticket requires changes in two independent repos.",
      repoSelection: {
        type: "multi_repo",
        selectedRepoIds: [1, 2],
        candidateSummaries: [],
        repoReasoning: "Changes span repo-a and repo-b independently.",
      },
      multiRepoPlan: [
        {
          repoRef: "org/repo-a",
          objective: "Add API endpoint in repo-a.",
          acceptanceCriteria: ["Endpoint returns 200"],
          mergeOrder: 1,
        },
        {
          repoRef: "org/repo-b",
          objective: "Add consumer in repo-b.",
          acceptanceCriteria: ["Consumer processes events"],
          mergeOrder: 2,
        },
      ],
    });

    expect(assessment.repoSelection.type).toBe("multi_repo");
    expect(assessment.multiRepoPlan).toHaveLength(2);
    expect(assessment.multiRepoPlan![0].repoRef).toBe("org/repo-a");
    expect(assessment.multiRepoPlan![1].mergeOrder).toBe(2);
    expect(assessment.multiRepoBrief).toBeUndefined();
  });

  it("accepts multiRepoBrief for child run scoping", () => {
    const assessment = parseQualificationAssessment({
      qualified: true,
      templateMatched: "cpdev_template",
      requirementsSummary: ["Scoped to repo-a only."],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      qualificationReasoning: "Child run for repo-a.",
      repoSelection: {
        type: "multi_repo",
        selectedRepoIds: [1],
        candidateSummaries: [],
        repoReasoning: "Child run.",
      },
      multiRepoBrief: {
        repoRef: "org/repo-a",
        objective: "Add API endpoint in repo-a.",
        acceptanceCriteria: ["Endpoint returns 200"],
        mergeOrder: 1,
        runGroupId: 42,
      },
    });

    expect(assessment.multiRepoBrief?.repoRef).toBe("org/repo-a");
    expect(assessment.multiRepoBrief?.runGroupId).toBe(42);
  });

  it("accepts multiBranchRetrofitPlan for same-repo target branch fan-out", () => {
    const assessment = parseQualificationAssessment({
      qualified: true,
      templateMatched: "retrofit_template",
      requirementsSummary: [
        "Retrofit CPDEV-1234 from master to multiple medhok release branches.",
      ],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      qualificationReasoning: "Complete multi-branch retrofit block.",
      repoSelection: baseRepoSelection,
      multiBranchRetrofitPlan: {
        sourceJiraKey: "CPDEV-1234",
        repoRef: "medhok-monorepo",
        sourceBranch: "master",
        targetBranches: [
          "medhok-monorepo-3.17",
          "medhok-monorepo-3.18",
        ],
        skippedTargetBranches: [],
      },
    });

    expect(assessment.multiBranchRetrofitPlan?.targetBranches).toEqual([
      "medhok-monorepo-3.17",
      "medhok-monorepo-3.18",
    ]);
    expect(assessment.retrofitContext).toBeUndefined();
  });

  it("accepts multiBranchRetrofitBrief for child run branch scoping", () => {
    const assessment = parseQualificationAssessment({
      qualified: true,
      templateMatched: "retrofit_template",
      requirementsSummary: ["Retrofit CPDEV-1234 to medhok-monorepo-3.17."],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      qualificationReasoning: "Child run for one retrofit target.",
      repoSelection: baseRepoSelection,
      retrofitContext: {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "master",
        targetBranch: "medhok-monorepo-3.17",
      },
      multiBranchRetrofitBrief: {
        sourceJiraKey: "CPDEV-1234",
        repoRef: "medhok-monorepo",
        sourceBranch: "master",
        targetBranch: "medhok-monorepo-3.17",
        targetOrder: 1,
        totalTargets: 2,
        runGroupId: 42,
      },
    });

    expect(assessment.multiBranchRetrofitBrief?.targetBranch).toBe(
      "medhok-monorepo-3.17",
    );
    expect(assessment.multiBranchRetrofitBrief?.runGroupId).toBe(42);
  });
});

describe("RepoSelectionTypeSchema", () => {
  it("includes multi_repo as a valid type", () => {
    const result = RepoSelectionTypeSchema.parse("multi_repo");
    expect(result).toBe("multi_repo");
  });

  it("rejects unknown types", () => {
    expect(() => RepoSelectionTypeSchema.parse("unknown_type")).toThrow();
  });
});

describe("MultiRepoSliceSchema", () => {
  it("validates a valid slice", () => {
    const slice = MultiRepoSliceSchema.parse({
      repoRef: "org/repo-a",
      objective: "Add API",
      acceptanceCriteria: ["Returns 200"],
      mergeOrder: 1,
    });
    expect(slice.repoRef).toBe("org/repo-a");
    expect(slice.mergeOrder).toBe(1);
  });

  it("rejects blank repoRef", () => {
    expect(() =>
      MultiRepoSliceSchema.parse({
        repoRef: "",
        objective: "Add API",
        acceptanceCriteria: ["Returns 200"],
        mergeOrder: 1,
      }),
    ).toThrow();
  });

  it("rejects empty acceptanceCriteria array", () => {
    expect(() =>
      MultiRepoSliceSchema.parse({
        repoRef: "org/repo-a",
        objective: "Add API",
        acceptanceCriteria: [],
        mergeOrder: 1,
      }),
    ).toThrow();
  });

  it("rejects non-positive mergeOrder", () => {
    expect(() =>
      MultiRepoSliceSchema.parse({
        repoRef: "org/repo-a",
        objective: "Add API",
        acceptanceCriteria: ["AC1"],
        mergeOrder: 0,
      }),
    ).toThrow();
  });
});

describe("MultiRepoBriefSchema", () => {
  it("validates a brief without optional runGroupId", () => {
    const brief = MultiRepoBriefSchema.parse({
      repoRef: "org/repo-b",
      objective: "Consumer change",
      acceptanceCriteria: ["Processes events"],
      mergeOrder: 2,
    });
    expect(brief.runGroupId).toBeUndefined();
  });

  it("validates a brief with runGroupId", () => {
    const brief = MultiRepoBriefSchema.parse({
      repoRef: "org/repo-b",
      objective: "Consumer change",
      acceptanceCriteria: ["Processes events"],
      mergeOrder: 2,
      runGroupId: 7,
    });
    expect(brief.runGroupId).toBe(7);
  });
});

describe("MultiBranchRetrofitPlanSchema", () => {
  it("validates a plan with multiple target branches", () => {
    const plan = MultiBranchRetrofitPlanSchema.parse({
      sourceJiraKey: "CPDEV-1234",
      repoRef: "medhok-monorepo",
      sourceBranch: "master",
      targetBranches: ["medhok-monorepo-3.17", "medhok-monorepo-3.18"],
      skippedTargetBranches: [],
    });

    expect(plan.targetBranches).toHaveLength(2);
  });

  it("rejects single-target fan-out plans", () => {
    expect(() =>
      MultiBranchRetrofitPlanSchema.parse({
        sourceJiraKey: "CPDEV-1234",
        repoRef: "medhok-monorepo",
        sourceBranch: "master",
        targetBranches: ["medhok-monorepo-3.17"],
        skippedTargetBranches: [],
      }),
    ).toThrow();
  });
});

describe("MultiBranchRetrofitBriefSchema", () => {
  it("validates a child brief", () => {
    const brief = MultiBranchRetrofitBriefSchema.parse({
      sourceJiraKey: "CPDEV-1234",
      repoRef: "medhok-monorepo",
      sourceBranch: "master",
      targetBranch: "medhok-monorepo-3.17",
      targetOrder: 1,
      totalTargets: 2,
    });

    expect(brief.targetOrder).toBe(1);
  });
});
