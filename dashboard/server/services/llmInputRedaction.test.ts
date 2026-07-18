import { describe, expect, it } from "vitest";
import {
  redactBucketForLlm,
  redactFailureAttributionForLlm,
  redactJiraExampleForLlm,
  redactMissingSignalImpactForLlm,
  redactOperationalBottlenecksForLlm,
  redactRepoStatusForLlm,
  redactTicketQualityForLlm,
} from "./llmInputRedaction.js";
import type {
  OneShotFailureAttributionSummary,
  OneShotMissingSignalImpact,
  OneShotOperationalBottleneckSummary,
  OneShotRepoStatusSummary,
  OneShotStatisticsBucket,
  OneShotStatisticsJiraExample,
  OneShotTicketQualityAnalysis,
} from "../types/oneshot.js";

const example: OneShotStatisticsJiraExample = {
  jiraKey: "CPDEV-1",
  dashboardId: "run-1",
  title:
    "UUHIP | Rx ExRM Case Type Assigning Appeal Untimely When Built from 360Member",
  jiraUrl: "https://jira.example.com/browse/CPDEV-1",
};

describe("redactJiraExampleForLlm", () => {
  it("returns only the jiraKey", () => {
    const out = redactJiraExampleForLlm(example);
    expect(out).toEqual({ jiraKey: "CPDEV-1" });
    expect("title" in out).toBe(false);
    expect("jiraUrl" in out).toBe(false);
    expect("dashboardId" in out).toBe(false);
  });

  it("does not retain title text in any form", () => {
    const out = redactJiraExampleForLlm(example);
    expect(JSON.stringify(out)).not.toMatch(/UUHIP/);
    expect(JSON.stringify(out)).not.toMatch(/Appeal Untimely/);
  });
});

describe("redactBucketForLlm", () => {
  const bucket: OneShotStatisticsBucket = {
    id: "ticket_family:dashboard-and-ui-changes",
    label: "Dashboard and UI changes",
    kind: "ticket_family",
    sampleSize: 13,
    completed: 11,
    failed: 2,
    noAction: 0,
    passRate: 0.846,
    avgTokens: 50000,
    avgUsd: 0.5,
    examples: [example],
  };

  it("strips example titles", () => {
    const out = redactBucketForLlm(bucket);
    expect(out.examples).toEqual([{ jiraKey: "CPDEV-1" }]);
    expect(JSON.stringify(out)).not.toMatch(/UUHIP/);
  });

  it("preserves controlled-vocabulary fields and numeric metrics", () => {
    const out = redactBucketForLlm(bucket);
    expect(out.id).toBe(bucket.id);
    expect(out.label).toBe(bucket.label);
    expect(out.kind).toBe(bucket.kind);
    expect(out.sampleSize).toBe(13);
    expect(out.completed).toBe(11);
    expect(out.failed).toBe(2);
    expect(out.passRate).toBeCloseTo(0.846);
  });

  it("does not include avgTokens or avgUsd (those are deterministic-layer-only)", () => {
    const out = redactBucketForLlm(bucket);
    expect("avgTokens" in out).toBe(false);
    expect("avgUsd" in out).toBe(false);
  });
});

describe("redactFailureAttributionForLlm", () => {
  const summary: OneShotFailureAttributionSummary = {
    totalFailures: 7,
    excludedFromDenominator: 4,
    countsByAttribution: { oneshot: 0, ticket: 0, mixed: 1, unknown: 6 },
    byCategory: [
      {
        errorCategory: "unknown",
        attribution: "unknown",
        sampleSize: 6,
        passRateInCohort: 0,
        wilson95: { low: 0, high: 0.39 },
        examples: [example, { ...example, jiraKey: "CPDEV-22236" }],
        significant: false,
      },
    ],
    attributionVersion: 2,
  };

  it("strips titles from byCategory examples", () => {
    const out = redactFailureAttributionForLlm(summary);
    expect(out.byCategory[0].examples).toEqual([
      { jiraKey: "CPDEV-1" },
      { jiraKey: "CPDEV-22236" },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/UUHIP/);
  });

  it("preserves counts and significance flag", () => {
    const out = redactFailureAttributionForLlm(summary);
    expect(out.totalFailures).toBe(7);
    expect(out.excludedFromDenominator).toBe(4);
    expect(out.attributionVersion).toBe(2);
    expect(out.byCategory[0].significant).toBe(false);
    expect(out.byCategory[0].errorCategory).toBe("unknown");
    expect(out.byCategory[0].attribution).toBe("unknown");
  });

  it("does not include passRateInCohort or wilson95 (deterministic-only)", () => {
    const out = redactFailureAttributionForLlm(summary);
    expect("passRateInCohort" in out.byCategory[0]).toBe(false);
    expect("wilson95" in out.byCategory[0]).toBe(false);
  });
});

describe("redactMissingSignalImpactForLlm", () => {
  const impact: OneShotMissingSignalImpact = {
    signal: "co:acceptance_criteria+testing_notes",
    label: "Acceptance criteria + Testing notes",
    signals: ["acceptance_criteria", "testing_notes"],
    missing: {
      sampleSize: 14,
      terminalCount: 9,
      completed: 6,
      failed: 3,
      noAction: 0,
      passRate: 0.66,
      wilson95: { low: 0.35, high: 0.88 },
    },
    present: {
      sampleSize: 28,
      terminalCount: 19,
      completed: 14,
      failed: 5,
      noAction: 0,
      passRate: 0.74,
      wilson95: { low: 0.51, high: 0.88 },
    },
    deltaPassRate: 8,
    significant: false,
    examples: {
      missingFailedOrNoAction: [example],
      presentPassed: [{ ...example, jiraKey: "CPDEV-2" }],
    },
  };

  it("strips example titles in both buckets", () => {
    const out = redactMissingSignalImpactForLlm(impact);
    expect(out.examples.missingFailedOrNoAction).toEqual([
      { jiraKey: "CPDEV-1" },
    ]);
    expect(out.examples.presentPassed).toEqual([{ jiraKey: "CPDEV-2" }]);
    expect(JSON.stringify(out)).not.toMatch(/UUHIP/);
  });

  it("preserves signal, signals, label, deltaPassRate, significant", () => {
    const out = redactMissingSignalImpactForLlm(impact);
    expect(out.signal).toBe("co:acceptance_criteria+testing_notes");
    expect(out.signals).toEqual(["acceptance_criteria", "testing_notes"]);
    expect(out.label).toBe("Acceptance criteria + Testing notes");
    expect(out.deltaPassRate).toBe(8);
    expect(out.significant).toBe(false);
  });
});

describe("redactTicketQualityForLlm", () => {
  const ticketQuality = {
    rubric: {
      rubricVersion: "v1.0",
      detectionPatternsVersion: "v1.0",
      weights: {
        acceptance_criteria: 35,
        substantive_description: 20,
        expected_behavior_scope: 15,
        repo_file_service_hints: 15,
        testing_notes: 10,
        out_of_scope_constraints: 5,
      },
      tierCutoffs: { strong: 80, adequate: 60, weak: 30 },
      thresholds: {
        bucketClaimMinN: 10,
        missingSignalCohortMinN: 10,
        weakRecommendationMinShare: 0.2,
        dataHygieneMissingDescriptionMinShare: 0.15,
        dataHygieneMinN: 10,
        stratifiedCoverageMinShare: 0.6,
      },
    },
    disclaimer: "x",
    totalIntake: 1,
    averageScore: 80,
    readinessDistribution: [
      {
        id: "strong",
        label: "Strong",
        sampleSize: 1,
        share: 1,
        cohort: {
          sampleSize: 1,
          terminalCount: 1,
          completed: 1,
          failed: 0,
          noAction: 0,
          passRate: 1,
          wilson95: null,
        },
        averageScore: 90,
        examples: [example],
      },
    ],
    passRateByTier: [],
    templateFit: [],
    missingSignalImpact: [],
    dataHygieneCallout: {
      id: "missing-description-share",
      title: "Many tickets lack a description",
      summary: "x",
      examples: [example],
    },
    stratifiedReadinessGap: {
      weak: {
        sampleSize: 0,
        terminalCount: 0,
        completed: 0,
        failed: 0,
        noAction: 0,
        passRate: 0,
        wilson95: null,
      },
      nonWeak: {
        sampleSize: 0,
        terminalCount: 0,
        completed: 0,
        failed: 0,
        noAction: 0,
        passRate: 0,
        wilson95: null,
      },
      significantOverall: false,
      eligibleWeakCoverageShare: 0,
      significantWeakCoverageShare: 0,
      qualifiesForRecommendation: false,
      dominantStrata: [],
      recommendationSummary: null,
    },
  } as unknown as OneShotTicketQualityAnalysis;

  it("strips example titles from readinessDistribution and dataHygieneCallout", () => {
    const out = redactTicketQualityForLlm(ticketQuality);
    expect(JSON.stringify(out)).not.toMatch(/UUHIP/);
    expect(out.dataHygieneCallout?.examples).toEqual([{ jiraKey: "CPDEV-1" }]);
  });

  it("preserves rubric, totalIntake, averageScore, stratifiedReadinessGap", () => {
    const out = redactTicketQualityForLlm(ticketQuality);
    expect(out.rubric.rubricVersion).toBe("v1.0");
    expect(out.totalIntake).toBe(1);
    expect(out.averageScore).toBe(80);
    expect(out.stratifiedReadinessGap.qualifiesForRecommendation).toBe(false);
  });

  it("drops the disclaimer string (it's a deterministic-layer-only display field)", () => {
    const out = redactTicketQualityForLlm(ticketQuality);
    expect("disclaimer" in out).toBe(false);
  });
});

describe("redactRepoStatusForLlm", () => {
  const repoStatus: OneShotRepoStatusSummary = {
    range: "30d",
    generatedAt: "2026-05-14T12:00:00.000Z",
    statusVersion: 1,
    rows: [
      {
        repoKey: "repo:core-app",
        repoLabel: "core-app",
        status: "watch",
        statusReason:
          "Ticket with a member identifier failed in testing and should stay deterministic-only.",
        isUnresolved: false,
        sampleSize: 6,
        terminalCount: 6,
        completed: 5,
        failed: 1,
        noAction: 0,
        passRate: 5 / 6,
        wilson95: { low: 0.44, high: 0.97 },
        avgTokens: 1000,
        avgUsd: 0.5,
        topStageIssue: {
          stage: "testing",
          label: "Testing",
          failed: 1,
          noAction: 0,
          affected: 1,
          shareOfRepoIssues: 1,
        },
        topFailureAttribution: {
          attribution: "oneshot",
          errorCategory: "test_runner_skipped",
          label: "Testing Error",
          sampleSize: 1,
        },
        examples: [example],
      },
    ],
  };

  it("strips display reasons and example titles while preserving controlled repo status metrics", () => {
    const out = redactRepoStatusForLlm(repoStatus);
    expect(out.rows[0]).toMatchObject({
      repoKey: "repo:core-app",
      repoLabel: "core-app",
      status: "watch",
      sampleSize: 6,
      completed: 5,
      failed: 1,
    });
    expect(out.rows[0].examples).toEqual([{ jiraKey: "CPDEV-1" }]);
    expect(JSON.stringify(out)).not.toMatch(/member identifier/i);
    expect(JSON.stringify(out)).not.toMatch(/UUHIP/);
    expect("statusReason" in out.rows[0]).toBe(false);
    expect("avgTokens" in out.rows[0]).toBe(false);
    expect("avgUsd" in out.rows[0]).toBe(false);
  });
});

describe("redactOperationalBottlenecksForLlm", () => {
  const bottlenecks: OneShotOperationalBottleneckSummary = {
    range: "30d",
    generatedAt: "2026-05-14T12:00:00.000Z",
    bottleneckVersion: 1,
    rows: [
      {
        id: "repo_resolution:unresolved",
        kind: "repo_resolution",
        severity: "high",
        title: "Unresolved repository routing",
        summary:
          "Ticket with member identifier UUHIP-123 could not be routed.",
        nextStep:
          "Review repo routing evidence for these tickets before guessing a target repository.",
        affected: 3,
        failed: 3,
        noAction: 0,
        passRate: 0,
        wilson95: { low: 0, high: 0.56 },
        repoKey: "repo:unresolved",
        repoLabel: "Unresolved repository",
        stage: "qualification",
        stageLabel: "Qualification",
        failureAttribution: {
          attribution: "ticket",
          errorCategory: "ticket_quality",
          label: "Ticket Not Ready",
        },
        costUsd: 1.25,
        tokens: 12_000,
        examples: [example],
      },
    ],
  };

  it("strips bottleneck summaries and example titles while preserving controlled metrics", () => {
    const out = redactOperationalBottlenecksForLlm(bottlenecks);
    expect(out.rows[0]).toMatchObject({
      id: "repo_resolution:unresolved",
      kind: "repo_resolution",
      severity: "high",
      title: "Unresolved repository routing",
      affected: 3,
      repoLabel: "Unresolved repository",
    });
    expect(out.rows[0].examples).toEqual([{ jiraKey: "CPDEV-1" }]);
    expect(JSON.stringify(out)).not.toMatch(/member identifier/i);
    expect(JSON.stringify(out)).not.toMatch(/UUHIP/);
    expect("summary" in out.rows[0]).toBe(false);
  });
});

describe("redaction smoke: PHI-shaped strings never leak", () => {
  // Real-prod ticket title shapes that could contain PHI markers in the wild.
  const phiShaped = [
    "Member 12345 cannot view claims",
    "Patient John Doe DOB 1980-01-01",
    "MRN 9876543210 in Provider Portal",
    "UUHIP | Rx ExRM Case Type Assigning Appeal Untimely",
  ];

  for (const title of phiShaped) {
    it(`drops "${title.slice(0, 30)}..." from bucket examples`, () => {
      const bucket: OneShotStatisticsBucket = {
        id: "ticket_family:test",
        label: "Test",
        kind: "ticket_family",
        sampleSize: 1,
        completed: 0,
        failed: 1,
        noAction: 0,
        passRate: 0,
        avgTokens: 0,
        avgUsd: 0,
        examples: [
          { jiraKey: "CPDEV-1", dashboardId: "run-1", title, jiraUrl: null },
        ],
      };
      const out = redactBucketForLlm(bucket);
      expect(JSON.stringify(out)).not.toContain(title.split(" ")[0]);
    });
  }
});
