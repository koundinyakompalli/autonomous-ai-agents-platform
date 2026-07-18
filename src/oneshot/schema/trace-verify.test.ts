import { describe, expect, it } from "vitest";
import type { OneShotPlan } from "./plan.js";
import {
  TRACE_CSV_HEADER,
  buildOneShotTraceArtifact,
  evaluateTraceGuardrails,
  parseOneShotVerifyReport,
  parseCsvRecords,
  renderTraceCsv,
  verifyOneShotTraceArtifact,
  type OneShotTraceArtifact,
  VERIFY_MODE_THRESHOLDS,
} from "./trace-verify.js";

const PLAN: OneShotPlan = {
  jiraKey: "CPDEV-25000",
  repoName: "core-app",
  branchName: "master",
  baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
  summary: "Add authorization-aware member lookup validation",
  specs: [
    {
      id: "SPEC-1",
      objective: "Validate authorized member lookup",
      acceptanceCriteria: [
        "Authorized users can retrieve member details with synthetic member identifiers",
        "Unauthorized users cannot retrieve member details",
      ],
      targetFiles: ["src/member/MemberLookupService.ts"],
      implementationNotes: ["Follow existing service validation pattern."],
      validationSteps: ["npm test -- member lookup"],
    },
  ],
  assumptions: [],
  openQuestions: [],
  outOfScope: [],
  risks: [],
};

function buildTraceForPlan(plan: OneShotPlan = PLAN): OneShotTraceArtifact {
  return buildOneShotTraceArtifact({
    jiraKey: plan.jiraKey,
    planVersion: 1,
    plan,
    generatedAt: "2026-05-28T12:00:00.000Z",
  });
}

function buildTrace(): OneShotTraceArtifact {
  return buildTraceForPlan();
}

function planWithTestingStrategy(): OneShotPlan {
  return {
    ...PLAN,
    testingStrategy: {
      mode: "test_first",
      existingTestEvidence: [
        {
          id: "member-lookup-test-surface",
          kind: "test_file",
          path: "src/member/MemberLookupService.test.ts",
          summary: "Planner inspected the focused member lookup test surface.",
          supportingEvidence: ["Read src/member/MemberLookupService.test.ts."],
        },
      ],
      plannedAutomatedTests: [
        {
          id: "AUTO-SPEC-1",
          testFile: "src/member/MemberLookupService.test.ts",
          relatedSpecIds: ["SPEC-1"],
          testType: "unit",
          scenario: "Unauthorized synthetic member lookup is rejected before details are returned.",
          assertions: [
            "Unauthorized lookup returns an authorization error.",
            "Authorized lookup still returns synthetic member details.",
          ],
          failFirst: true,
          command: "npm test -- member lookup",
          syntheticDataNotes: "Use synthetic member identifiers only.",
        },
      ],
      validationCommands: [
        {
          command: "npm test -- member lookup",
          expectedResult: "Focused member lookup tests pass.",
          scope: "focused",
          relatedSpecIds: ["SPEC-1"],
        },
      ],
      manualChecks: [],
      traceGuidance: [
        {
          id: "TRACE-MEMBER-AUTH",
          section: "C",
          testType: "Unit",
          scenario: "Preserve the planned unauthorized lookup unit test.",
          relatedSpecIds: ["SPEC-1"],
          priority: "High",
        },
      ],
      coverageGaps: [],
    },
  } as OneShotPlan;
}

describe("TRACE CSV contract", () => {
  it("renders the exact 16-column header and one row per step", () => {
    const trace = buildTrace();
    const csv = renderTraceCsv(trace);
    const records = parseCsvRecords(csv);

    expect(records[0].join(",")).toBe(TRACE_CSV_HEADER);
    expect(records[0]).toHaveLength(16);
    expect(records.every((row) => row.length === 16)).toBe(true);

    const firstCase = trace.testCases[0];
    const openingRow = records.find((row) => row[2] === firstCase.id);
    expect(openingRow).toBeTruthy();
    expect(openingRow?.[6]).toBe("");
    expect(openingRow?.[7]).toBe("");
    expect(openingRow?.[12]).toBe(firstCase.testCaseType);
    expect(openingRow?.[13]).toBe(firstCase.executionMode);

    const stepRows = records.filter((row) => /^Step \d+$/.test(row[6]));
    expect(stepRows).toHaveLength(
      trace.testCases.reduce((total, testCase) => total + testCase.steps.length, 0),
    );
    expect(stepRows.every((row) => row[0] === "" && row[12] === "")).toBe(true);
  });

  it("uses RFC 4180 escaping for commas, quotes, and embedded newlines", () => {
    const trace = buildTrace();
    trace.testCases[0].steps[0].description =
      'Open "Member, Lookup"\n- Use synthetic member';

    const csv = renderTraceCsv(trace);
    expect(csv).toContain('"Open ""Member, Lookup""\n- Use synthetic member"');
    expect(parseCsvRecords(csv).every((row) => row.length === 16)).toBe(true);
  });

  it("rejects the stale 8-column TRACE schema", () => {
    const trace = buildTrace();
    const staleCsv = [
      "Test Case ID,Category,Title,Preconditions,Steps,Expected Result,Priority,Status",
      'TC001,Functional,Title,Precondition,"1. Step",Expected,High,Not Run',
    ].join("\n");

    const result = evaluateTraceGuardrails(trace, staleCsv, true);

    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => finding.id)).toContain(
      "trace_csv_legacy_eight_column_header",
    );
  });
});

describe("TRACE guardrails", () => {
  it("maps every acceptance criterion and includes Section A/B/C", () => {
    const trace = buildTrace();

    expect(trace.acceptanceCriteriaCoverage).toMatchObject({
      total: 2,
      covered: 2,
      coveragePercent: 100,
      uncovered: [],
    });
    expect(trace.sections.A.length).toBeGreaterThan(0);
    expect(trace.sections.B.length).toBeGreaterThan(0);
    expect(trace.sections.C.length).toBeGreaterThan(0);
    expect(trace.traceGuardrailResult.passed).toBe(true);
  });

  it("requires authorization preconditions for PHI scenarios", () => {
    const trace = buildTrace();
    trace.testCases[0].preconditions = ["Synthetic patient data is available."];
    trace.testCases[0].steps[0].description = "Open patient PHI details.";

    const result = evaluateTraceGuardrails(trace, renderTraceCsv(trace), true);

    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => finding.id)).toContain(
      "trace_phi_requires_auth",
    );
  });

  it("sanitizes source-derived PHI and PII before rendering artifacts and CSV", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      summary: "Send member notifications to person@example.com.",
      specs: [
        {
          ...PLAN.specs[0],
          objective: "Notify person@example.com about member lookup",
          acceptanceCriteria: [
            "Planner must send the real user email person@example.com to the API.",
            "Do not persist SSN 123-45-6789 or phone 555-123-4567.",
          ],
          targetFiles: ["src/member/person@example.com/MemberLookupService.ts"],
          implementationNotes: [
            "Replace fixture 123-45-6789 before implementation.",
          ],
          validationSteps: ["npm test -- --user person@example.com"],
        },
      ],
    });
    const csv = renderTraceCsv(trace);
    const artifactText = JSON.stringify(trace);

    expect(artifactText).not.toContain("person@example.com");
    expect(artifactText).not.toContain("123-45-6789");
    expect(artifactText).not.toContain("555-123-4567");
    expect(csv).not.toContain("person@example.com");
    expect(csv).not.toContain("123-45-6789");
    expect(csv).not.toContain("555-123-4567");
    expect(artifactText).toContain("[synthetic-email]");
    expect(artifactText).toContain("[synthetic-ssn]");
    expect(artifactText).toContain("[synthetic-phone]");
    expect(
      trace.traceGuardrailResult.findings.map((finding) => finding.id),
    ).not.toContain("trace_no_real_phi_pii");
  });

  it("uses testingStrategy planned automated tests for Section C", () => {
    const trace = buildTraceForPlan(planWithTestingStrategy());
    const sectionCText = trace.testCases
      .filter((testCase) => testCase.section === "C")
      .map((testCase) => JSON.stringify(testCase))
      .join("\n");

    expect((trace as unknown as { testingStrategy?: { plannedAutomatedTestIds: string[] } }).testingStrategy).toMatchObject({
      plannedAutomatedTestIds: ["AUTO-SPEC-1"],
    });
    expect(sectionCText).toContain("AUTO-SPEC-1");
    expect(sectionCText).toContain(
      "Unauthorized synthetic member lookup is rejected before details are returned.",
    );
    expect(sectionCText).toContain("npm test -- member lookup");
  });

  it("emits Section C coverage for every planned automated test even when related specs are stale", () => {
    const plan = planWithTestingStrategy();
    plan.testingStrategy!.plannedAutomatedTests.push({
      id: "AUTO-STALE-SPEC",
      testFile: "src/member/MemberLookupService.test.ts",
      relatedSpecIds: ["SPEC-404"],
      testType: "regression",
      scenario: "Legacy related spec id still preserves the planned regression test.",
      assertions: ["The regression test intent appears in Section C."],
      failFirst: false,
      command: "npm test -- member lookup",
      syntheticDataNotes: "Use synthetic member identifiers only.",
    });

    const trace = buildTraceForPlan(plan);
    const sectionCText = trace.testCases
      .filter((testCase) => testCase.section === "C")
      .map((testCase) => JSON.stringify(testCase))
      .join("\n");

    expect(trace.testingStrategy?.plannedAutomatedTestIds).toEqual([
      "AUTO-SPEC-1",
      "AUTO-STALE-SPEC",
    ]);
    expect(sectionCText).toContain("AUTO-SPEC-1");
    expect(sectionCText).toContain("AUTO-STALE-SPEC");
    expect(sectionCText).toContain("Unmatched related spec IDs: SPEC-404");
  });
});

describe("VERIFY guardrails", () => {
  it("approves a complete measured TRACE artifact", () => {
    const trace = buildTrace();
    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
      generatedAt: "2026-05-28T12:00:00.000Z",
    });

    expect(report.recommendation).toBe("APPROVED");
    expect(report.riskLevel).toBe("LOW");
    expect(report.acceptanceCriteriaCoverage.coveragePercent).toBe(100);
    expect(report.degradedModeDisclaimers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("UNABLE_TO_VERIFY: Historical Jira defect patterns"),
      ]),
    );
  });

  it("rejects TRACE output that omits testingStrategy planned automated tests", () => {
    const trace = buildTraceForPlan(planWithTestingStrategy());
    trace.testCases = trace.testCases.filter(
      (testCase) => !JSON.stringify(testCase).includes("AUTO-SPEC-1"),
    );
    trace.sections.C = trace.testCases
      .filter((testCase) => testCase.section === "C")
      .map((testCase) => testCase.id);

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("REJECTED");
    expect(report.gaps.map((gap) => gap.id)).toContain(
      "verify_testing_strategy_planned_tests",
    );
  });

  it("parses legacy VERIFY reports without mode thresholds", () => {
    const trace = buildTrace();
    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
      generatedAt: "2026-05-28T12:00:00.000Z",
    });
    const { verifyModeThresholds: _verifyModeThresholds, ...legacyReport } =
      report;

    expect(parseOneShotVerifyReport(legacyReport).verifyModeThresholds).toBeUndefined();
  });

  it("allows source-linked Jira references from acceptance criteria", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      specs: [
        {
          ...PLAN.specs[0],
          acceptanceCriteria: [
            "Prior defect CPDEV-12345 remains rejected for unauthorized member lookup.",
            PLAN.specs[0].acceptanceCriteria[1],
          ],
        },
      ],
    });

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("APPROVED");
    expect(report.gaps.map((gap) => gap.id)).not.toContain(
      "verify_no_fabricated_historical_tickets",
    );
    expect(report.unverifiedClaims).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source-linked ticket CPDEV-12345"),
      ]),
    );
  });

  it("allows source-linked Jira references from testingStrategy planned automated tests", () => {
    const plan = planWithTestingStrategy();
    plan.testingStrategy!.plannedAutomatedTests[0] = {
      ...plan.testingStrategy!.plannedAutomatedTests[0],
      scenario:
        "Prior defect CPDEV-12345 remains rejected before unauthorized member lookup returns details.",
      assertions: [
        "Prior defect CPDEV-12345 remains covered by the fail-first planned test.",
      ],
    };
    const trace = buildTraceForPlan(plan);

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("APPROVED");
    expect(report.gaps.map((gap) => gap.id)).not.toContain(
      "verify_no_fabricated_historical_tickets",
    );
    expect(report.unverifiedClaims).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source-linked ticket CPDEV-12345"),
      ]),
    );
  });

  it("allows source-linked Jira references from plan objectives", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      specs: [
        {
          ...PLAN.specs[0],
          objective: "Resolve prior defect CPDEV-12345 regression",
        },
      ],
    });

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("APPROVED");
    expect(report.gaps.map((gap) => gap.id)).not.toContain(
      "verify_no_fabricated_historical_tickets",
    );
    expect(report.unverifiedClaims).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source-linked ticket CPDEV-12345"),
      ]),
    );
  });

  it("rejects generated historical Jira context when source only mentions the key plainly", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      specs: [
        {
          ...PLAN.specs[0],
          acceptanceCriteria: [
            "Use linked ticket CPDEV-12345 as request context for member lookup.",
            PLAN.specs[0].acceptanceCriteria[1],
          ],
        },
      ],
    });
    trace.testCases[0].steps[0].description =
      "Matches prior defect CPDEV-12345 before member lookup.";

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("REJECTED");
    expect(report.gaps.map((gap) => gap.id)).toContain(
      "verify_no_fabricated_historical_tickets",
    );
    expect(report.unverifiedClaims).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CPDEV-12345 without source or Jira evidence"),
      ]),
    );
  });

  it("does not treat TRACE title wrappers as historical source context for plain objective Jira keys", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      specs: [
        {
          ...PLAN.specs[0],
          objective: "Use linked ticket CPDEV-12345 as request context",
        },
      ],
    });

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("APPROVED");
    expect(report.gaps.map((gap) => gap.id)).not.toContain(
      "verify_no_fabricated_historical_tickets",
    );
  });

  it("rejects generated historical Jira context when objective only mentions the key plainly", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      specs: [
        {
          ...PLAN.specs[0],
          objective: "Use linked ticket CPDEV-12345 as request context",
        },
      ],
    });
    trace.testCases[0].steps[0].description =
      "Matches prior defect CPDEV-12345 before member lookup.";

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("REJECTED");
    expect(report.gaps.map((gap) => gap.id)).toContain(
      "verify_no_fabricated_historical_tickets",
    );
  });

  it("rejects generated historical Jira context in preconditions", () => {
    const trace = buildTrace();
    trace.testCases[0].preconditions.push(
      "Prior defect CPDEV-12345 must be reproduced before member lookup.",
    );

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("REJECTED");
    expect(report.gaps.map((gap) => gap.id)).toContain(
      "verify_no_fabricated_historical_tickets",
    );
  });

  it("allows source business percentage thresholds", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      specs: [
        {
          ...PLAN.specs[0],
          acceptanceCriteria: [
            "Reject synthetic lookup requests when confidence is below 80% threshold.",
            PLAN.specs[0].acceptanceCriteria[1],
          ],
        },
      ],
    });

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("APPROVED");
    expect(report.gaps.map((gap) => gap.id)).not.toContain(
      "verify_no_unmeasured_percentages",
    );
  });

  it("rejects generated measured percentage context when source only has a business threshold", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      specs: [
        {
          ...PLAN.specs[0],
          acceptanceCriteria: [
            "Reject synthetic lookup requests when confidence is below 80% threshold.",
            PLAN.specs[0].acceptanceCriteria[1],
          ],
        },
      ],
    });
    trace.testCases[0].steps[0].description =
      "Improves automated coverage by 80% after the lookup change.";

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("REJECTED");
    expect(report.gaps.map((gap) => gap.id)).toContain(
      "verify_no_unmeasured_percentages",
    );
    expect(report.unverifiedClaims).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unmeasured percentage claim(s): 80%"),
      ]),
    );
  });

  it("does not treat TRACE title wrappers as measured source context for objective thresholds", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      specs: [
        {
          ...PLAN.specs[0],
          objective: "Apply an 80% threshold for member lookup confidence",
        },
      ],
    });

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("APPROVED");
    expect(report.gaps.map((gap) => gap.id)).not.toContain(
      "verify_no_unmeasured_percentages",
    );
  });

  it("rejects generated measured percentage context when objective only has a business threshold", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      specs: [
        {
          ...PLAN.specs[0],
          objective: "Apply an 80% threshold for member lookup confidence",
        },
      ],
    });
    trace.testCases[0].steps[0].description =
      "Improves automated coverage by 80% after the lookup change.";

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("REJECTED");
    expect(report.gaps.map((gap) => gap.id)).toContain(
      "verify_no_unmeasured_percentages",
    );
  });

  it("allows source measured percentages from plan objectives", () => {
    const trace = buildTraceForPlan({
      ...PLAN,
      specs: [
        {
          ...PLAN.specs[0],
          objective: "Reduce failure rate by 80% for member lookup",
        },
      ],
    });

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("APPROVED");
    expect(report.gaps.map((gap) => gap.id)).not.toContain(
      "verify_no_unmeasured_percentages",
    );
    expect(report.unverifiedClaims).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source-derived percentage claim 80%"),
      ]),
    );
  });

  it("rejects fabricated historical tickets", () => {
    const trace = buildTrace();
    trace.testCases[0].steps[0].description =
      "Matches prior defect CPDEV-99999.";

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("REJECTED");
    expect(report.unverifiedClaims).toEqual(
      expect.arrayContaining([
        expect.stringContaining("UNABLE_TO_VERIFY"),
      ]),
    );
    expect(report.gaps.map((gap) => gap.id)).toEqual(
      expect.arrayContaining([
        "verify_no_fabricated_historical_tickets",
      ]),
    );
  });

  it("rejects fabricated historical tickets with single-digit issue numbers", () => {
    const trace = buildTrace();
    trace.testCases[0].steps[0].description =
      "Matches prior defect CPDEV-1.";

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("REJECTED");
    expect(report.gaps.map((gap) => gap.id)).toContain(
      "verify_no_fabricated_historical_tickets",
    );
    expect(report.unverifiedClaims).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CPDEV-1 without source or Jira evidence"),
      ]),
    );
  });

  it("rejects unsupported measured coverage percentages", () => {
    const trace = buildTrace();
    trace.testCases[0].steps[0].description =
      "Improves automated coverage by 95% without a measured report.";

    const report = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
    });

    expect(report.recommendation).toBe("REJECTED");
    expect(report.gaps.map((gap) => gap.id)).toContain(
      "verify_no_unmeasured_percentages",
    );
    expect(report.unverifiedClaims).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unmeasured percentage claim"),
      ]),
    );
  });

  it("applies strict, balanced, and lenient recommendation thresholds", () => {
    const trace = buildTrace();
    trace.acceptanceCriteriaCoverage = {
      ...trace.acceptanceCriteriaCoverage,
      coveragePercent: 90,
    };

    const strict = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
      mode: "strict",
    });
    const balanced = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
      mode: "balanced",
    });
    const lenient = verifyOneShotTraceArtifact({
      trace,
      csv: renderTraceCsv(trace),
      mode: "lenient",
    });

    expect(strict.recommendation).toBe("REJECTED");
    expect(balanced.recommendation).toBe("CONDITIONAL");
    expect(lenient.recommendation).toBe("APPROVED");
    expect(lenient.verifyModeThresholds).toEqual(VERIFY_MODE_THRESHOLDS.lenient);
  });
});
