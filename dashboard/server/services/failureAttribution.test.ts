import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  classifyErrorCategory,
  classifyFailureForRow,
  FAILURE_ATTRIBUTION_VERSION,
  summarizeFailureAttribution,
  type FailureClassification,
} from "./failureAttribution.js";
import type {
  OneShotDashboardRow,
  OneShotStatisticsJiraExample,
  OneShotTicketReadinessTier,
  QualifierOutcome,
  QualifierOutcomeReasonCode,
} from "../types/oneshot.js";

function makeRow(
  overrides: Partial<OneShotDashboardRow> & {
    qualifierReasonCode?: QualifierOutcomeReasonCode;
    qualifierReason?: string | null;
    lastError?: string | null;
  } = {},
): OneShotDashboardRow {
  const qualifierOutcome: QualifierOutcome | null =
    overrides.qualifierReasonCode
      ? {
          disposition: "not_qualified",
          reasonCode: overrides.qualifierReasonCode,
          reason: overrides.qualifierReason ?? "test",
          qualifierMode: null,
          labels: [],
          latestRunState: null,
        }
      : null;
  return {
    dashboardId: "run-1",
    jiraKey: "CPDEV-1",
    title: "ticket",
    sourceTaskManagementId: 1,
    oneshotRunId: 1,
    customerName: null,
    displayState: "failed",
    progressStage: "planning",
    progressPercent: 0,
    repoName: "core-app",
    repoUrl: null,
    baseBranch: "main",
    baseCommitSha: null,
    implementationBranch: null,
    implementationCommitSha: null,
    workspace: null,
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    planReviewLoopCount: 0,
    maxPlanReviewLoops: 3,
    verificationLoopCount: 0,
    maxVerificationLoops: 3,
    currentPrUrl: null,
    qualificationSummary: null,
    qualifierOutcome,
    lastError: overrides.lastError ?? null,
    lastErrorSummary: overrides.lastError ?? null,
    readiness: null,
    readinessReasons: [],
    retry: null,
    deployment: {
      eligible: false,
      ready: false,
      light: "grey",
      status: "not_eligible",
      active: false,
      previewUrl: null,
      workflowUrl: null,
      imageUri: null,
      deployedCommitSha: null,
    },
    createdAt: "2026-05-14T10:00:00.000Z",
    lastManualRestartAt: null,
    updatedAt: "2026-05-14T10:30:00.000Z",
    totalTokensUsed: 1000,
    estimatedCostUsd: 0.01,
    costSource: "actual",
    ...overrides,
  } as OneShotDashboardRow;
}

const STRONG: OneShotTicketReadinessTier = "strong";
const WEAK: OneShotTicketReadinessTier = "weak";

describe("classifyErrorCategory", () => {
  it("matches infra patterns case-insensitively", () => {
    expect(classifyErrorCategory("git clone failed")).toBe("git_operation");
    expect(classifyErrorCategory("Bedrock 503 throttle")).toBe("llm_provider");
    expect(classifyErrorCategory("PutObject denied for S3")).toBe("s3_storage");
    expect(classifyErrorCategory("ECONNREFUSED writing run row")).toBe(
      "db_operation",
    );
    expect(classifyErrorCategory("ENOSPC on EFS workspace")).toBe("workspace");
    expect(
      classifyErrorCategory(
        "workspace_checkout_timeout: git worktree add failed or timed out",
      ),
    ).toBe("workspace");
    expect(classifyErrorCategory("GitHub pull request 422")).toBe("github_api");
    expect(classifyErrorCategory("token_budget_exceeded")).toBe("budget");
  });

  it("returns unknown for unrecognized strings and empty input", () => {
    expect(classifyErrorCategory("")).toBe("unknown");
    expect(classifyErrorCategory("something the rules don't match")).toBe(
      "unknown",
    );
  });

  it("classifies candidate integrity handoff failures as agent logic", () => {
    expect(
      classifyErrorCategory(
        "Candidate SHA integrity check failed: v2 run has no current candidate-version row.",
      ),
    ).toBe("agent_logic");
  });

  it("classifies plan-contract violation recovery failures as agent logic", () => {
    expect(classifyErrorCategory("plan_contract_violation_auto_replan")).toBe(
      "agent_logic",
    );
    expect(
      classifyErrorCategory(
        "Plan-contract auto-replan exhausted after 2 attempt(s). Implementation changed files outside the approved plan contract: src/oneshot/consumers/tester.ts.",
      ),
    ).toBe("agent_logic");
  });

  it("classifies planner grounding target failures as agent logic", () => {
    expect(
      classifyErrorCategory(
        "Planner target files are not backed by deterministic grounding: ticket_explicit_new_source rejected for MedicalMgmt/src/main/java/com/medhok/mm/server/event/CodeClassifierConfigChangedEvent.java",
      ),
    ).toBe("agent_logic");
  });

  it("classifies retrofit patch proof recovery failures as agent logic", () => {
    expect(classifyErrorCategory("retrofit_patch_incomplete_auto_replan")).toBe(
      "agent_logic",
    );
    expect(
      classifyErrorCategory(
        "Retrofit patch proof missing after 2 auto-replan attempt(s): Source commit abc1234 is unaccounted for.",
      ),
    ).toBe("agent_logic");
    expect(
      classifyErrorCategory(
        "retrofit_revision_proof_regressed: accepted source commit 9ce5326 was invalidated during implementation revision v2.",
      ),
    ).toBe("agent_logic");
    expect(
      classifyErrorCategory(
        "retrofit_contract_missing_mapping: Source commit abc1234 must map to targetFiles, adaptationFiles, or excluded rationale.",
      ),
    ).toBe("agent_logic");
    expect(
      classifyErrorCategory(
        "retrofit_contract_weak_adaptation_evidence: Adaptation file src/main/java/com/mhk/BaseUtils.java must cite source SHA.",
      ),
    ).toBe("agent_logic");
    expect(
      classifyErrorCategory(
        "partial source commit selection: sourceCommitSelectionComplete=false for selected retrofit source PR.",
      ),
    ).toBe("agent_logic");
  });

  it("classifies retrofit source lookup failures as GitHub API infrastructure", () => {
    expect(
      classifyErrorCategory(
        "retrofit_source_lookup_failed: Could not list source PR commits for https://github.com/mhk/repo/pull/123.",
      ),
    ).toBe("github_api");
    expect(
      classifyErrorCategory(
        "source_pr_lookup_failed: Could not list source PR evidence for https://github.com/mhk/repo/pull/123.",
      ),
    ).toBe("github_api");
    expect(
      classifyErrorCategory(
        "source_commit_lookup_failed: Git log failed while resolving CPDEV-25448.",
      ),
    ).toBe("github_api");
    expect(
      classifyErrorCategory(
        "target_branch_lookup_failed: Target branch lookup failed for core-app while resolving retrofit target medhok-monorepo-4.1.",
      ),
    ).toBe("github_api");
  });

  it("classifies true missing retrofit source evidence as ticket quality", () => {
    expect(
      classifyErrorCategory(
        "source_commit_not_found: Could not find exact source commit evidence for CPDEV-25448 on master.",
      ),
    ).toBe("ticket_quality");
  });

  it("classifies planner schema and retrofit contract normalization failures as plan validation", () => {
    expect(
      classifyErrorCategory(
        "Planner structured output failed schema validation after SDK success: schema_invalid_after_success at plannerDiscoveries.retrofitEvidence.sourcePrUrl.",
      ),
    ).toBe("plan_validation");
    expect(
      classifyErrorCategory(
        "retrofit_contract_missing_after_normalization: Retrofit planner output did not include plannerDiscoveries.retrofitExecutionContract.",
      ),
    ).toBe("plan_validation");
  });

  it("prefers schema validation evidence over generic stage attempt exhaustion", () => {
    expect(
      classifyErrorCategory(
        [
          "OneShot planner exhausted the maximum of 3 stage attempt(s).",
          "schemaValidationErrors: plannerDiscoveries.retrofitExecutionContract.sourcePrUrl must be a valid URL.",
        ].join("\n"),
      ),
    ).toBe("plan_validation");
  });

  it("classifies local SDK planner timeout sentinels as agent logic", () => {
    expect(
      classifyErrorCategory(
        "SDK_IDLE_TIMEOUT: no stream event for 120000ms, toolCalls=0, output=0",
      ),
    ).toBe("agent_logic");
    expect(classifyErrorCategory("SDK timeout after 900000ms")).toBe(
      "agent_logic",
    );
  });

  it("matches real-prod test-runner-skipped failure strings", () => {
    expect(
      classifyErrorCategory(
        "Declared runnable test command(s) were skipped: mvn -f MedicalMgmt/pom.xml test -Dtest=BffMedicalAppealsServiceTest",
      ),
    ).toBe("test_runner_skipped");
    expect(
      classifyErrorCategory(
        "Declared runnable test command(s) were skipped: pytest | mvn -f mhk-interopt-fhirhelper/pom.xml test",
      ),
    ).toBe("test_runner_skipped");
  });

  it("matches real-prod GitHub CI failure strings as ci_failure", () => {
    expect(
      classifyErrorCategory(
        "GitHub CI is pending across commit and pull request checks (0 status check(s), 6 check run(s)).",
      ),
    ).toBe("ci_failure");
    expect(
      classifyErrorCategory(
        "GitHub CI is failing across commit and pull request checks",
      ),
    ).toBe("ci_failure");
  });

  it("matches current qualifier ticket-readiness rejection patterns", () => {
    const reasons = [
      "Repository mismatch confirmed by inspection. No acceptance criteria are present and implementation would be speculative.",
      "The described fix is already present in the codebase and there is no pending implementation work.",
      "This is a validation-only / manual QA ticket with no new development work needed.",
      "Referenced tickets are unavailable and an image attachment cannot be inspected.",
      "The ticket requirements and codebase state are irreconcilably contradictory.",
      "SQS queue ARN is not specified, the trigger mechanism is undefined, and there is no SQS publishing infrastructure.",
      "Issue #1 resolution status is contradictory, issue #2 root cause is undetermined, referenced HERMES analysis findings are absent, and implementation would be speculative.",
      "The ticket bundles two issues with unresolved status on both, making bounded scoping for a single OneShot run impossible.",
      "SQS queue ARN is not specified, the trigger mechanism is undefined, no RxPA data model exists, and there is zero SQS publishing infrastructure.",
      "Ticket is missing both substantive description and acceptance criteria.",
    ];

    for (const reason of reasons) {
      expect(classifyErrorCategory(reason)).toBe("ticket_quality");
    }
  });

  it("classifies no-code-change and config-only qualifier rejections as ticket_quality", () => {
    const reasons = [
      "no_code_change_required",
      "no_code_changes_required",
      "No Java source code changes required",
      "Config Only",
      "scope_is_configuration_only",
      "scope_not_development",
      "not suitable for code-generation",
      "not implementable code ticket",
      "ticket_already_done",
      "ticket_already_closed",
    ];
    for (const reason of reasons) {
      expect(classifyErrorCategory(reason), reason).toBe("ticket_quality");
    }
  });

  it("does not falsely match benign 'test' or 'CI' phrases", () => {
    expect(classifyErrorCategory("test suite ran successfully")).toBe(
      "unknown",
    );
    expect(classifyErrorCategory("CI/CD setup is being reviewed")).toBe(
      "unknown",
    );
  });
});

describe("classifyFailure", () => {
  it("excludes qualifier-gating reason codes from the denominator", () => {
    const result = classifyFailure({
      row: makeRow({ qualifierReasonCode: "repo_unsupported" }),
      readinessTier: STRONG,
    });
    expect(result.attribution).toBe("unknown");
    expect(result.excludedFromDenominator).toBe(true);
  });

  it("attributes gate_hard_fail to the ticket", () => {
    const result = classifyFailure({
      row: makeRow({ qualifierReasonCode: "gate_hard_fail" }),
      readinessTier: WEAK,
    });
    expect(result.attribution).toBe("ticket");
    expect(result.errorCategory).toBe("ticket_quality");
    expect(result.excludedFromDenominator).toBe(false);
  });

  it("attributes ticket_quality category to the ticket regardless of tier", () => {
    const result = classifyFailure({
      row: makeRow({ lastError: "Gate score too low" }),
      readinessTier: STRONG,
    });
    expect(result.attribution).toBe("ticket");
  });

  it("attributes llm_rejected on a strong ticket to OneShot", () => {
    const result = classifyFailure({
      row: makeRow({ qualifierReasonCode: "llm_rejected" }),
      readinessTier: STRONG,
    });
    expect(result.attribution).toBe("oneshot");
  });

  it("uses qualifier rejection text to classify ticket-quality failures", () => {
    const cases = [
      {
        jiraKey: "CPDEV-22346",
        reason:
          "acceptance_criteria_missing; ambiguous_goal; scope_too_broad",
      },
      {
        jiraKey: "CPDEV-22347",
        reason:
          "acceptance_criteria_missing; ambiguous_scope; shared_component_scope_unresolved",
      },
      {
        jiraKey: "CPDEV-22348",
        reason: "acceptance_criteria_missing; ambiguous_goal",
      },
    ];

    for (const fixture of cases) {
      const result = classifyFailure({
        row: makeRow({
          jiraKey: fixture.jiraKey,
          displayState: "qualification_failed",
          oneshotRunId: null,
          progressStage: "qualification",
          qualifierReasonCode: "llm_rejected",
          qualifierReason: fixture.reason,
          qualificationSummary: fixture.reason,
          lastError: null,
          lastErrorSummary: null,
        }),
        readinessTier: STRONG,
      });

      expect(result.errorCategory, fixture.jiraKey).toBe("ticket_quality");
      expect(result.attribution, fixture.jiraKey).toBe("ticket");
      expect(result.excludedFromDenominator, fixture.jiraKey).toBe(false);
    }
  });

  it("attributes infra failures on strong tickets to OneShot", () => {
    const result = classifyFailure({
      row: makeRow({ lastError: "ETIMEDOUT calling bedrock" }),
      readinessTier: STRONG,
    });
    expect(result.attribution).toBe("oneshot");
    expect(result.errorCategory).toBe("llm_provider");
  });

  it("attributes infra failures on weak tickets as mixed", () => {
    const result = classifyFailure({
      row: makeRow({ lastError: "git clone lock conflict" }),
      readinessTier: WEAK,
    });
    expect(result.attribution).toBe("mixed");
    expect(result.errorCategory).toBe("git_operation");
  });

  it("falls through to unknown for unrecognized errors", () => {
    const result = classifyFailure({
      row: makeRow({ lastError: "weird transient" }),
      readinessTier: STRONG,
    });
    expect(result.attribution).toBe("unknown");
    expect(result.errorCategory).toBe("unknown");
    expect(result.excludedFromDenominator).toBe(false);
  });

  it("keeps truly unmatched qualifier rejections unknown", () => {
    const result = classifyFailure({
      row: makeRow({
        displayState: "qualification_failed",
        progressStage: "qualification",
        oneshotRunId: null,
        qualifierReasonCode: "llm_rejected",
        qualifierReason: "unmapped qualifier text",
        qualificationSummary: "unmapped qualifier text",
      }),
      readinessTier: WEAK,
    });

    expect(result.attribution).toBe("unknown");
    expect(result.errorCategory).toBe("unknown");
  });

  it("builds row-level Ticket Not Ready attribution without statistics context", () => {
    const attribution = classifyFailureForRow(
      makeRow({
        displayState: "qualification_failed",
        progressStage: "qualification",
        oneshotRunId: null,
        qualifierReasonCode: "llm_rejected",
        qualifierReason:
          "acceptance_criteria_missing: no explicit Acceptance Criteria section is present; unresolved open questions require product owner confirmation",
        qualificationSummary:
          "acceptance_criteria_missing: no explicit Acceptance Criteria section is present; unresolved open questions require product owner confirmation",
      }),
    );

    expect(attribution).toMatchObject({
      attribution: "ticket",
      errorCategory: "ticket_quality",
      qualifierReasonCode: "llm_rejected",
      label: "Ticket Not Ready",
      excludedFromDenominator: false,
    });
  });

  it("classifies qualifier no-code/config-only rejections as Ticket Not Ready", () => {
    const reasons = [
      "no_code_change_required",
      "scope_is_configuration_only",
      "scope_not_development",
      "ticket_already_closed",
      "not suitable for code-generation",
    ];
    for (const reason of reasons) {
      const attribution = classifyFailureForRow(
        makeRow({
          displayState: "qualification_failed",
          progressStage: "qualification",
          oneshotRunId: null,
          qualifierReasonCode: "llm_rejected",
          qualifierReason: reason,
          qualificationSummary: reason,
          lastError: null,
          lastErrorSummary: null,
        }),
      );
      expect(attribution?.attribution, reason).toBe("ticket");
      expect(attribution?.errorCategory, reason).toBe("ticket_quality");
      expect(attribution?.label, reason).toBe("Ticket Not Ready");
    }
  });

  it("renders parked qualifier runtime outcomes as excluded Qualifier Errors", () => {
    const attribution = classifyFailureForRow(
      makeRow({
        displayState: "qualification_failed",
        progressStage: "qualification",
        oneshotRunId: null,
        qualifierReasonCode: "llm_error_parked",
        lastError: "ETIMEDOUT calling bedrock",
      }),
    );

    expect(attribution).toMatchObject({
      attribution: "oneshot",
      errorCategory: "llm_provider",
      qualifierReasonCode: "llm_error_parked",
      label: "Qualifier Error",
      excludedFromDenominator: true,
    });
  });

  it("renders branch lookup failures as excluded Qualifier Errors", () => {
    const attribution = classifyFailureForRow(
      makeRow({
        displayState: "qualification_failed",
        progressStage: "qualification",
        oneshotRunId: null,
        qualifierReasonCode:
          "branch_lookup_failed" as QualifierOutcomeReasonCode,
        qualifierReason:
          "GitHub branch lookup failed while resolving core-app: auth failure while checking master.",
        lastError: null,
      }),
    );

    expect(attribution).toMatchObject({
      attribution: "oneshot",
      errorCategory: "github_api",
      qualifierReasonCode: "branch_lookup_failed",
      label: "Qualifier Error",
      excludedFromDenominator: true,
    });
  });

  it("builds row-level Qualifier Error attribution for non-gating infra failures", () => {
    const attribution = classifyFailureForRow(
      makeRow({
        displayState: "qualification_failed",
        progressStage: "qualification",
        oneshotRunId: null,
        lastError: "Bedrock 503 overloaded",
      }),
    );

    expect(attribution).toMatchObject({
      attribution: "oneshot",
      errorCategory: "llm_provider",
      label: "Qualifier Error",
      excludedFromDenominator: false,
    });
  });

  it("labels non-qualifier OneShot implementation failures as Implementation Error", () => {
    const attribution = classifyFailureForRow(
      makeRow({
        dashboardId: "run-106",
        jiraKey: "CPDEV-15158",
        displayState: "failed",
        progressStage: "implementation",
        lastError:
          "Run exceeded maximum age of 24 hours (age: 99h). Run has been abandoned.",
      }),
    );

    expect(attribution).toMatchObject({
      attribution: "oneshot",
      errorCategory: "budget",
      label: "Implementation Error",
      excludedFromDenominator: false,
    });
  });

  it.each([
    ["planning", "Planning Error"],
    ["review", "Review Error"],
    ["code_review", "Code Review Error"],
    ["testing", "Testing Error"],
  ] as const)(
    "labels OneShot %s failures with the stage label",
    (stage, label) => {
      const attribution = classifyFailureForRow(
        makeRow({
          displayState: "failed",
          progressStage: stage,
          lastError: "Bedrock 503 overloaded",
        }),
      );

      expect(attribution).toMatchObject({
        attribution: "oneshot",
        errorCategory: "llm_provider",
        label,
      });
    },
  );

  it("attributes test_runner_skipped on a strong ticket to OneShot", () => {
    const result = classifyFailure({
      row: makeRow({
        lastError:
          "Declared runnable test command(s) were skipped: mvn -f core-app/pom.xml test",
      }),
      readinessTier: STRONG,
    });
    expect(result.attribution).toBe("oneshot");
    expect(result.errorCategory).toBe("test_runner_skipped");
  });

  it("attributes test_runner_skipped on a weak ticket as mixed", () => {
    const result = classifyFailure({
      row: makeRow({
        lastError: "Declared runnable test command(s) were skipped: pytest",
      }),
      readinessTier: WEAK,
    });
    expect(result.attribution).toBe("mixed");
    expect(result.errorCategory).toBe("test_runner_skipped");
  });

  it("attributes ci_failure on a strong ticket to OneShot", () => {
    const result = classifyFailure({
      row: makeRow({
        lastError:
          "GitHub CI is pending across commit and pull request checks (0 status check(s), 6 check run(s)).",
      }),
      readinessTier: STRONG,
    });
    expect(result.attribution).toBe("oneshot");
    expect(result.errorCategory).toBe("ci_failure");
  });

  it("attributes ci_failure on a weak ticket as mixed", () => {
    const result = classifyFailure({
      row: makeRow({
        lastError: "GitHub CI is failing across commit and pull request checks",
      }),
      readinessTier: WEAK,
    });
    expect(result.attribution).toBe("mixed");
    expect(result.errorCategory).toBe("ci_failure");
  });
});

describe("summarizeFailureAttribution", () => {
  const example: OneShotStatisticsJiraExample = {
    jiraKey: "CPDEV-1",
    dashboardId: "run-1",
    title: "t",
    jiraUrl: null,
  };
  const wilson = (s: number, n: number) =>
    n === 0 ? null : { low: s / Math.max(n, 1), high: s / Math.max(n, 1) };
  const wilson95 = (successes: number, total: number) => {
    if (total === 0) return null;
    const z = 1.96;
    const phat = successes / total;
    const denominator = 1 + (z * z) / total;
    const center = phat + (z * z) / (2 * total);
    const margin =
      z *
      Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);
    return {
      low: Math.max(0, (center - margin) / denominator),
      high: Math.min(1, (center + margin) / denominator),
    };
  };

  it("excludes gating outcomes from totalFailures and counts", () => {
    const oneshotFailure: FailureClassification = {
      attribution: "oneshot",
      errorCategory: "llm_provider",
      qualifierReasonCode: null,
      readinessTier: STRONG,
      rationale: "x",
      excludedFromDenominator: false,
    };
    const gating: FailureClassification = {
      attribution: "unknown",
      errorCategory: "unknown",
      qualifierReasonCode: "repo_unsupported",
      readinessTier: STRONG,
      rationale: "x",
      excludedFromDenominator: true,
    };
    const summary = summarizeFailureAttribution({
      classifications: [
        { classification: oneshotFailure, row: makeRow(), example },
        { classification: gating, row: makeRow(), example },
      ],
      overallPassRate: 0.7,
      minSignificantSize: 1,
      wilsonInterval: wilson,
    });
    expect(summary.totalFailures).toBe(1);
    expect(summary.excludedFromDenominator).toBe(1);
    expect(summary.countsByAttribution.oneshot).toBe(1);
    expect(summary.countsByAttribution.unknown).toBe(0);
    expect(summary.attributionVersion).toBe(FAILURE_ATTRIBUTION_VERSION);
  });

  it("groups byCategory by errorCategory + attribution and caps examples at 5", () => {
    const cls: FailureClassification = {
      attribution: "oneshot",
      errorCategory: "llm_provider",
      qualifierReasonCode: null,
      readinessTier: STRONG,
      rationale: "x",
      excludedFromDenominator: false,
    };
    const seven = Array.from({ length: 7 }).map((_, i) => ({
      classification: cls,
      row: makeRow({ dashboardId: `run-${i}`, jiraKey: `CPDEV-${i}` }),
      example: { ...example, dashboardId: `run-${i}`, jiraKey: `CPDEV-${i}` },
    }));
    const summary = summarizeFailureAttribution({
      classifications: seven,
      overallPassRate: 0.7,
      minSignificantSize: 1,
      wilsonInterval: wilson,
    });
    expect(summary.byCategory).toHaveLength(1);
    expect(summary.byCategory[0].sampleSize).toBe(7);
    expect(summary.byCategory[0].examples).toHaveLength(5);
  });

  it("keeps n=2 within noise against a 57% pass-rate baseline", () => {
    const cls: FailureClassification = {
      attribution: "oneshot",
      errorCategory: "agent_logic",
      qualifierReasonCode: null,
      readinessTier: STRONG,
      rationale: "x",
      excludedFromDenominator: false,
    };
    const classifications = Array.from({ length: 2 }).map((_, i) => ({
      classification: cls,
      row: makeRow({ dashboardId: `run-${i}`, jiraKey: `CPDEV-${i}` }),
      example: { ...example, dashboardId: `run-${i}`, jiraKey: `CPDEV-${i}` },
    }));

    const summary = summarizeFailureAttribution({
      classifications,
      overallPassRate: 0.57,
      minSignificantSize: 5,
      wilsonInterval: wilson95,
    });

    expect(summary.byCategory[0].sampleSize).toBe(2);
    expect(summary.byCategory[0].wilson95?.high).toBeGreaterThan(0.57);
    expect(summary.byCategory[0].significant).toBe(false);
  });

  it("marks n=5 significant against a 57% pass-rate baseline", () => {
    const cls: FailureClassification = {
      attribution: "oneshot",
      errorCategory: "agent_logic",
      qualifierReasonCode: null,
      readinessTier: STRONG,
      rationale: "x",
      excludedFromDenominator: false,
    };
    const classifications = Array.from({ length: 5 }).map((_, i) => ({
      classification: cls,
      row: makeRow({ dashboardId: `run-${i}`, jiraKey: `CPDEV-${i}` }),
      example: { ...example, dashboardId: `run-${i}`, jiraKey: `CPDEV-${i}` },
    }));

    const summary = summarizeFailureAttribution({
      classifications,
      overallPassRate: 0.57,
      minSignificantSize: 5,
      wilsonInterval: wilson95,
    });

    expect(summary.byCategory[0].sampleSize).toBe(5);
    expect(summary.byCategory[0].wilson95?.high).toBeLessThan(0.57);
    expect(summary.byCategory[0].significant).toBe(true);
  });
});

describe("classifyErrorCategory — handoff infrastructure errors", () => {
  it("classifies workspace lease timeout message as workspace category", () => {
    expect(
      classifyErrorCategory(
        "Timed out acquiring OneShot workspace lease repo-cache: /repos/my-repo",
      ),
    ).toBe("workspace");
  });

  it("classifies planning_publish_failed disposition string as workspace category", () => {
    expect(classifyErrorCategory("planning_publish_failed")).toBe("workspace");
  });

  it("classifies workspace_setup_failed disposition string as workspace category", () => {
    expect(classifyErrorCategory("workspace_setup_failed")).toBe("workspace");
  });

  it("classifies planning publish exhausted error as workspace category", () => {
    expect(
      classifyErrorCategory(
        "Planning publish exhausted all retry attempts: ETIMEDOUT",
      ),
    ).toBe("workspace");
  });
});
