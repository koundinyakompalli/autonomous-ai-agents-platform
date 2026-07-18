import { describe, expect, it } from "vitest";
import {
  RETROFIT_EXECUTION_CONTRACT_VERSION,
  buildRetrofitExecutionContractFromEvidence,
  deriveRetrofitAllowedFilesFromExecutionContract,
  isRetrofitRunContext,
  mergeRetrofitExecutionContractWithStatuses,
  parseRetrofitExecutionContract,
  validateRetrofitExecutionContractForPlan,
} from "./retrofit-execution-contract.js";
import type { RetrofitSourceEvidence } from "./retrofit-source-evidence.js";

function sourceEvidence(): RetrofitSourceEvidence {
  return {
    sourceJiraKey: "CPDEV-25281",
    sourceBranch: "master",
    targetBranch: "medhok-monorepo-4.0",
    sourceRepoName: "core-app",
    sourceRepoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    sourcePrUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/82",
    commitSelectionMethod: "source_pr",
    sourceCommitSelectionComplete: true,
    selectedCommits: [
      {
        sha: "9ce5326",
        subject: "CPDEV-25281 add reroute handling",
        files: [
          "src/main/java/com/mhk/UIComponentService.java",
          "src/test/java/com/mhk/UIComponentServiceTest.java",
        ],
      },
    ],
    touchedFiles: [
      "src/main/java/com/mhk/UIComponentService.java",
      "src/test/java/com/mhk/UIComponentServiceTest.java",
    ],
    evidenceSummary: "Resolved all source PR commits.",
  };
}

describe("isRetrofitRunContext", () => {
  it("is false for regular OneShot inputs", () => {
    expect(isRetrofitRunContext({})).toBe(false);
    expect(
      isRetrofitRunContext({ plan: { plannerDiscoveries: {} } }),
    ).toBe(false);
  });

  it("is true only when retrofit facts are present", () => {
    expect(
      isRetrofitRunContext({
        retrofitSourceEvidence: sourceEvidence(),
      }),
    ).toBe(true);
    expect(
      isRetrofitRunContext({
        plan: {
          plannerDiscoveries: {
            retrofitExecutionContract: { version: RETROFIT_EXECUTION_CONTRACT_VERSION },
          },
        },
      }),
    ).toBe(true);
  });
});

describe("RetrofitExecutionContractV1", () => {
  it("builds a contract from complete source evidence and source-backed adaptation entries", () => {
    const contract = buildRetrofitExecutionContractFromEvidence({
      evidence: sourceEvidence(),
      fileChangeContract: [
        {
          path: "src/main/java/com/mhk/BaseUtils.java",
          editable: true,
          role: "runtime_required",
          rationale:
            "Target branch utility adaptation for source commit 9ce5326 and UIComponentService.java.",
          supportingEvidence: ["9ce5326 changed UIComponentService.java"],
          allowedChanges: ["Preserve CPDEV-25281 behavior"],
        },
      ],
    });

    expect(contract).toEqual(
      expect.objectContaining({
        version: RETROFIT_EXECUTION_CONTRACT_VERSION,
        sourceJiraKey: "CPDEV-25281",
        sourcePrUrl:
          "https://github.com/mhk-repos/cp-medhok-monorepo/pull/82",
        commitSelectionMethod: "source_pr",
        sourceCommitSelectionComplete: true,
      }),
    );
    expect(contract.selectedCommits[0]).toEqual(
      expect.objectContaining({
        sha: "9ce5326",
        sourceFiles: expect.arrayContaining([
          "src/main/java/com/mhk/UIComponentService.java",
        ]),
        targetFiles: expect.arrayContaining([
          "src/main/java/com/mhk/UIComponentService.java",
        ]),
        adaptationFiles: ["src/main/java/com/mhk/BaseUtils.java"],
      }),
    );
    expect(deriveRetrofitAllowedFilesFromExecutionContract(contract)).toEqual(
      expect.arrayContaining([
        "src/main/java/com/mhk/UIComponentService.java",
        "src/main/java/com/mhk/BaseUtils.java",
      ]),
    );
  });

  it("omits blank optional source repo and PR fields when seeding a contract", () => {
    const contract = buildRetrofitExecutionContractFromEvidence({
      evidence: {
        ...sourceEvidence(),
        sourceRepoName: " ",
        sourceRepoUrl: "",
        sourcePrUrl: "   ",
      },
    });

    expect(contract.sourceRepoName).toBeUndefined();
    expect(contract.sourceRepoUrl).toBeUndefined();
    expect(contract.sourcePrUrl).toBeUndefined();
  });

  it("rejects adaptation files that only have generic rationale", () => {
    const evidence = sourceEvidence();
    const contract = {
      ...buildRetrofitExecutionContractFromEvidence({ evidence }),
      selectedCommits: [
        {
          ...buildRetrofitExecutionContractFromEvidence({ evidence })
            .selectedCommits[0],
          adaptationFiles: ["src/main/java/com/mhk/BaseUtils.java"],
        },
      ],
      allowedFileMappings: [
        {
          sourceSha: "9ce5326",
          sourceFiles: ["src/main/java/com/mhk/UIComponentService.java"],
          targetFiles: ["src/main/java/com/mhk/UIComponentService.java"],
          adaptationFiles: ["src/main/java/com/mhk/BaseUtils.java"],
          rationale: "Target branch needs a helper.",
        },
      ],
    };

    const violations = validateRetrofitExecutionContractForPlan({
      contract,
      evidence,
      fileChangeContract: [
        {
          path: "src/main/java/com/mhk/BaseUtils.java",
          editable: true,
          role: "runtime_required",
          rationale: "Target branch needs a helper.",
        },
      ],
    });

    expect(violations).toContain(
      "retrofit_contract_weak_adaptation_evidence: Adaptation file src/main/java/com/mhk/BaseUtils.java must cite source SHA, source Jira, or source file evidence.",
    );
  });

  it("rejects selected-commit adaptation files missing source-backed file contract evidence", () => {
    const evidence = sourceEvidence();
    const contract = {
      ...buildRetrofitExecutionContractFromEvidence({ evidence }),
      selectedCommits: [
        {
          ...buildRetrofitExecutionContractFromEvidence({ evidence })
            .selectedCommits[0],
          adaptationFiles: ["src/main/java/com/mhk/BaseUtils.java"],
        },
      ],
      allowedFileMappings: [],
    };

    expect(
      validateRetrofitExecutionContractForPlan({
        contract,
        evidence,
        fileChangeContract: [],
      }),
    ).toContain(
      "retrofit_contract_missing_file_contract: Adaptation file src/main/java/com/mhk/BaseUtils.java must have an editable fileChangeContract entry.",
    );

    expect(
      validateRetrofitExecutionContractForPlan({
        contract,
        evidence,
        fileChangeContract: [
          {
            path: "src/main/java/com/mhk/BaseUtils.java",
            editable: true,
            role: "runtime_required",
            rationale: "Target branch needs a helper.",
          },
        ],
      }),
    ).toContain(
      "retrofit_contract_weak_adaptation_evidence: Adaptation file src/main/java/com/mhk/BaseUtils.java must cite source SHA, source Jira, or source file evidence.",
    );
  });

  it("requires a contract when retrofit evidence exists", () => {
    expect(
      validateRetrofitExecutionContractForPlan({
        contract: null,
        evidence: sourceEvidence(),
      }),
    ).toEqual([
      "retrofit_contract_missing: Retrofit plans must include plannerDiscoveries.retrofitExecutionContract.",
    ]);
  });

  it("rejects not_attempted as a terminal selected source commit status", () => {
    const evidence = sourceEvidence();
    const contract = buildRetrofitExecutionContractFromEvidence({ evidence });

    expect(
      validateRetrofitExecutionContractForPlan({
        contract,
        evidence,
      }),
    ).toContain(
      "retrofit_contract_invalid_status: Source commit 9ce5326 has non-terminal or unaccounted status not_attempted.",
    );
  });

  it("rejects changed files outside source or adaptation mappings", () => {
    const evidence = sourceEvidence();
    const contract = buildRetrofitExecutionContractFromEvidence({ evidence });

    expect(
      validateRetrofitExecutionContractForPlan({
        contract,
        evidence,
        changedFiles: ["src/main/java/com/mhk/Unrelated.java"],
      }),
    ).toContain(
      "retrofit_contract_scope_violation: Changed file src/main/java/com/mhk/Unrelated.java is not mapped to selected source commit evidence.",
    );
  });

  it("merges accepted implementation statuses into the contract", () => {
    const evidence = sourceEvidence();
    const contract = buildRetrofitExecutionContractFromEvidence({ evidence });

    const merged = mergeRetrofitExecutionContractWithStatuses({
      contract,
      statuses: [
        {
          sourceSha: "9ce5326",
          status: "adapted",
          sourceFiles: ["src/main/java/com/mhk/UIComponentService.java"],
          targetFiles: ["src/main/java/com/mhk/UIComponentService.java"],
          adaptationFiles: ["src/main/java/com/mhk/BaseUtils.java"],
          proofSnippets: ["Mapped reroute guard into target branch utility."],
          validationEvidence: ["Focused test covers reroute guard."],
        },
      ],
    });

    expect(merged.selectedCommits[0]).toEqual(
      expect.objectContaining({
        status: "adapted",
        adaptationFiles: ["src/main/java/com/mhk/BaseUtils.java"],
        proofSnippets: ["Mapped reroute guard into target branch utility."],
      }),
    );
    expect(parseRetrofitExecutionContract(merged)).not.toBeNull();
  });
});
