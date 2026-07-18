import { describe, expect, it } from "vitest";
import type { OneShotPlan } from "./schema/plan.js";
import {
  buildRetrofitWorkflowSection,
  isRetrofitWorkflowRequired,
} from "./retrofit-workflow.js";

const retrofitPlan = {
  jiraKey: "CPDEV-650",
  repoName: "core-app",
  branchName: "medhok-monorepo-4.0",
  baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
  summary: "Retrofit source fix.",
  specs: [],
  assumptions: [],
  openQuestions: [],
  outOfScope: [],
  risks: [],
  plannerDiscoveries: {
    retrofitEvidence: {
      sourceJiraKey: "CPDEV-25281",
      sourceBranch: "master",
      targetBranch: "medhok-monorepo-4.0",
      selectedCommits: [
        {
          sha: "9ce5326",
          subject: "CPDEV-25281 Sort issue fix",
          files: ["MedicalMgmt/src/main/java/com/medhok/BaseUtils.java"],
          alreadyApplied: false,
        },
      ],
      touchedFiles: ["MedicalMgmt/src/main/java/com/medhok/BaseUtils.java"],
      alreadyApplied: false,
      evidenceSummary: "Source commit requires branch-specific adaptation.",
    },
  },
} satisfies OneShotPlan;

describe("retrofit workflow prompt helper", () => {
  it("detects retrofit from approved plan evidence", () => {
    expect(isRetrofitWorkflowRequired({ plan: retrofitPlan })).toBe(true);
  });

  it("detects retrofit from source evidence before a plan exists", () => {
    expect(
      isRetrofitWorkflowRequired({
        retrofitSourceEvidence: {
          sourceJiraKey: "CPDEV-25281",
          sourceBranch: "master",
          targetBranch: "medhok-monorepo-4.0",
          sourceRepoName: "core-app",
          sourceRepoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          selectedCommits: [],
          touchedFiles: [],
          evidenceSummary: "source evidence",
        },
      }),
    ).toBe(true);
  });

  it("detects retrofit from prior revision proof", () => {
    expect(
      isRetrofitWorkflowRequired({
        priorStatuses: [
          {
            sourceSha: "9ce5326",
            status: "adapted",
            sourceFiles: ["source/BaseUtils.java"],
            targetFiles: ["target/BaseUtils.java"],
            adaptationFiles: [],
            proofSnippets: ["mapped source hunk"],
            validationEvidence: [],
          },
        ],
      }),
    ).toBe(true);
  });

  it("builds a stage-specific workflow section with dynamic run facts", () => {
    const section = buildRetrofitWorkflowSection({
      workflowPrompt: "CANONICAL RETROFIT WORKFLOW\n- Do not semantically rediscover.",
      stage: "implementer",
      plan: retrofitPlan,
      allowedFiles: ["MedicalMgmt/src/main/java/com/medhok/BaseUtils.java"],
      priorStatuses: [
        {
          sourceSha: "9ce5326",
          status: "adapted",
          sourceFiles: ["source/BaseUtils.java"],
          targetFiles: ["target/BaseUtils.java"],
          adaptationFiles: ["target/BaseUtils.java"],
          proofSnippets: ["source hunk mapped to target"],
          validationEvidence: ["implementation v1 accepted"],
        },
      ],
    });

    expect(section).toContain("## Required Retrofit Workflow");
    expect(section).toContain("CANONICAL RETROFIT WORKFLOW");
    expect(section).toContain("- Stage: implementer");
    expect(section).toContain("- Source Jira key: CPDEV-25281");
    expect(section).toContain("- Selected source SHAs: 9ce5326");
    expect(section).toContain(
      "- Allowed implementation/adaptation files: MedicalMgmt/src/main/java/com/medhok/BaseUtils.java",
    );
    expect(section).toContain("9ce5326 status=adapted");
  });

  it("builds workflow facts from retrofit patch conflict context", () => {
    const section = buildRetrofitWorkflowSection({
      workflowPrompt: "CANONICAL RETROFIT WORKFLOW",
      stage: "planner",
      conflictContext: {
        sourceJiraKey: "CPDEV-25281",
        sourceBranch: "master",
        targetBranch: "medhok-monorepo-4.0",
        selectedShas: ["9ce5326"],
        allowedFiles: ["target/BaseUtils.java"],
        changedFiles: ["target/UIComponentService.java"],
        perCommitStatus: [
          {
            sha: "9ce5326",
            sourceFiles: ["source/UIComponentService.java"],
            targetFiles: ["target/UIComponentService.java"],
            adaptationFiles: ["target/BaseUtils.java"],
          },
        ],
      },
    });

    expect(section).toContain("- Source Jira key: CPDEV-25281");
    expect(section).toContain("- Source branch: master");
    expect(section).toContain("- Target branch: medhok-monorepo-4.0");
    expect(section).toContain("- Selected source SHAs: 9ce5326");
    expect(section).toContain("source/UIComponentService.java");
    expect(section).toContain("target/BaseUtils.java");
  });

  it("omits the workflow section for non-retrofit input", () => {
    expect(
      buildRetrofitWorkflowSection({
        workflowPrompt: "RETROFIT RULES",
        stage: "planner",
      }),
    ).toBe("");
  });
});
