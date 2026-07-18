import { describe, expect, it } from "vitest";
import { CORE_GUARDRAIL_IDS, parseOneShotPlan } from "./schema/plan.js";
import {
  validateImplementedFilesAgainstPlanContract,
  validateOneShotPlanContract,
} from "./plan-contract.js";

function buildValidPlan() {
  return parseOneShotPlan({
    jiraKey: "CPDEV-23734",
    repoName: "core-app",
    branchName: "master",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "Add a cancel button to the member search UI.",
    implementationMode: "code_change",
    specs: [
      {
        id: "SPEC-1",
        objective: "Add the button and runtime stylesheet rule.",
        acceptanceCriteria: ["The cancel button is available in the UI."],
        targetFiles: [
          "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
          "MedicalMgmt/src/main/webapp/Medhok3.css",
          "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java",
        ],
        implementationNotes: ["Follow the inspected button styling pattern."],
        validationSteps: ["mvn -pl MedicalMgmt -DskipTests compile"],
      },
    ],
    fileChangeContract: [
      {
        path: "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
        role: "runtime_required",
        editable: true,
        rationale: "The Java view owns the button markup.",
        supportingEvidence: ["Read MemberSearchForm.java."],
        allowedChanges: ["Insert the cancel button near existing controls."],
      },
      {
        path: "MedicalMgmt/src/main/webapp/Medhok3.css",
        role: "runtime_required",
        editable: true,
        rationale: "The root stylesheet is loaded by the page.",
        supportingEvidence: ["Read index.html and Medhok3.css."],
        allowedChanges: ["Add the cancel button style block."],
      },
      {
        path: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csSecondaryButton.scss",
        role: "read_only_evidence",
        editable: false,
        rationale: "Sibling source parity evidence.",
        supportingEvidence: ["Read _csSecondaryButton.scss."],
      },
      {
        path: "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java",
        role: "test_required",
        editable: true,
        rationale: "Focused unit coverage must verify the button style assignment.",
        supportingEvidence: ["Read adjacent member-search test patterns."],
        allowedChanges: ["Add a fail-first unit test for the cancel button style."],
      },
    ],
    plannedCodeChanges: [
      {
        targetFile:
          "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
        symbolOrRegion: "button setup",
        changeType: "insert",
        beforeSnippet: "buttonPanel.add(searchButton);",
        afterSketch:
          "Button cancelButton = new Button(constants.cancel());\ncancelButton.addStyleName(\"cs-cancel-button\");",
        rationale: "Localized insertion with no broad refactor.",
        supportingEvidence: ["Existing button setup in MemberSearchForm.java."],
        confidence: "high",
      },
      {
        targetFile: "MedicalMgmt/src/main/webapp/Medhok3.css",
        symbolOrRegion: "custom button styles",
        changeType: "insert",
        afterSketch:
          ".cs-cancel-button { background-color: #c62828; color: #fff; }",
        rationale: "Runtime stylesheet must carry the visible UI style.",
        supportingEvidence: ["Existing cs-secondary-button style block."],
        confidence: "medium",
      },
    ],
    testingStrategy: {
      mode: "test_first",
      existingTestEvidence: [
        {
          id: "member-search-test-surface",
          kind: "test_file",
          path: "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java",
          summary: "Nearest member-search test surface exists.",
          supportingEvidence: ["Read MemberSearchFormTest.java."],
        },
      ],
      plannedAutomatedTests: [
        {
          id: "AUTO-SPEC-1",
          testFile:
            "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java",
          relatedSpecIds: ["SPEC-1"],
          testType: "unit",
          scenario: "Cancel button style is assigned when the search form is built.",
          assertions: ["The cancel button includes cs-cancel-button."],
          failFirst: true,
          command:
            "mvn -pl MedicalMgmt -Dtest=MemberSearchFormTest test",
          syntheticDataNotes: "Use synthetic UI fixtures only.",
        },
      ],
      validationCommands: [
        {
          command: "mvn -pl MedicalMgmt -Dtest=MemberSearchFormTest test",
          expectedResult: "Focused member-search test passes.",
          scope: "focused",
          relatedSpecIds: ["SPEC-1"],
        },
      ],
      manualChecks: [],
      traceGuidance: [
        {
          id: "TRACE-CANCEL-STYLE",
          section: "C",
          testType: "Unit",
          scenario: "TRACE should preserve the cancel button unit-test intent.",
          relatedSpecIds: ["SPEC-1"],
          priority: "High",
        },
      ],
      coverageGaps: [],
    },
    guardrailReport: {
      coreChecks: CORE_GUARDRAIL_IDS.map((id) => ({
        id,
        severity: "high",
        status: "passed",
        applicabilityReason: "Core guardrail applies to every ticket.",
        evidence: ["Plan contains explicit file contract and validation."],
        requiredAction: "Implementer must preserve this guardrail.",
      })),
      domainChecks: [
        {
          id: "pfos-security-remediation-scope",
          severity: "high",
          status: "not_applicable",
          applicabilityReason:
            "Ticket evidence is UI work, not CVE/package remediation.",
          evidence: ["Ticket summary says cancel button UI."],
          requiredAction:
            "Do not restrict this UI ticket to pom.xml-only PFOS remediation.",
        },
      ],
      implementerChecks: [
        {
          id: "editable-file-contract",
          severity: "high",
          status: "passed",
          applicabilityReason: "Every editable file is covered.",
          evidence: ["fileChangeContract lists Java and CSS files."],
          requiredAction: "Stay inside editable files.",
        },
      ],
    },
    implementerGuardrails: [
      {
        id: "file-scope",
        instruction: "Edit only files marked editable in fileChangeContract.",
        appliesToFiles: [
        "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
        "MedicalMgmt/src/main/webapp/Medhok3.css",
        "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java",
      ],
      required: true,
      },
    ],
  });
}

describe("validateOneShotPlanContract", () => {
  it("accepts a PRISM-style UI plan that treats label-only PFOS as not applicable", () => {
    const result = validateOneShotPlanContract(buildValidPlan(), {
      processingMode: "standard",
      jiraLabels: ["PFOS"],
    });

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("blocks code-change plans missing the guardrail report", () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-1",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Update a source file.",
      implementationMode: "code_change",
      specs: [
        {
          id: "SPEC-1",
          objective: "Update source.",
          acceptanceCriteria: ["Source is updated."],
          targetFiles: ["src/example.ts"],
          implementationNotes: ["Make a localized change."],
          validationSteps: ["npm test"],
        },
      ],
    });

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
      jiraLabels: [],
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_guardrail_report",
          severity: "high",
        }),
      ]),
    );
  });

  it("blocks unsupported PFOS remediation applicability from label alone", () => {
    const plan = buildValidPlan();
    plan.guardrailReport!.domainChecks[0] = {
      ...plan.guardrailReport!.domainChecks[0],
      status: "passed",
      applicabilityReason: "PFOS label is present.",
      evidence: ["Jira labels include PFOS."],
      requiredAction: "Only edit pom.xml files.",
    };

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
      jiraLabels: ["PFOS"],
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported_pfos_applicability",
          severity: "high",
        }),
      ]),
    );
  });

  it("blocks editable files not covered by implementer guardrails", () => {
    const plan = buildValidPlan();
    plan.implementerGuardrails = [
      {
        id: "java-only",
        instruction: "Edit only the Java file.",
        appliesToFiles: [
          "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
        ],
        required: true,
      },
    ];

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "editable_files_missing_implementer_guardrails",
          paths: [
            "MedicalMgmt/src/main/webapp/Medhok3.css",
            "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java",
          ],
        }),
      ]),
    );
  });

  it("blocks code-change plans missing the testing strategy", () => {
    const plan = buildValidPlan();
    delete (plan as { testingStrategy?: unknown }).testingStrategy;

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_testing_strategy",
          severity: "high",
        }),
      ]),
    );
  });

  it("blocks planned automated tests outside the editable test contract", () => {
    const plan = buildValidPlan();
    plan.testingStrategy!.plannedAutomatedTests[0] = {
      ...plan.testingStrategy!.plannedAutomatedTests[0],
      testFile:
        "MedicalMgmt/src/test/java/com/medhok/mm/client/member/UnplannedTest.java",
    };

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planned_test_outside_contract",
          paths: [
            "MedicalMgmt/src/test/java/com/medhok/mm/client/member/UnplannedTest.java",
          ],
        }),
      ]),
    );
  });

  it("blocks planned automated tests that reference unknown specs", () => {
    const plan = buildValidPlan();
    plan.testingStrategy!.plannedAutomatedTests[0] = {
      ...plan.testingStrategy!.plannedAutomatedTests[0],
      relatedSpecIds: ["SPEC-404"],
    };

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planned_test_unknown_spec",
          severity: "high",
          paths: ["AUTO-SPEC-1:SPEC-404"],
        }),
      ]),
    );
  });

  it("blocks testing adequacy passed without automated tests or explicit coverage gaps", () => {
    const plan = buildValidPlan();
    plan.testingStrategy = {
      ...plan.testingStrategy!,
      mode: "manual_verification",
      plannedAutomatedTests: [],
      manualChecks: [],
      coverageGaps: [],
    };

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "testing_adequacy_without_evidence",
          severity: "high",
        }),
        expect.objectContaining({
          code: "missing_automated_test_or_gap",
          severity: "high",
        }),
      ]),
    );
  });

  it("blocks testing adequacy passed for manual-only plans even with explicit manual evidence", () => {
    const plan = buildValidPlan();
    plan.testingStrategy = {
      ...plan.testingStrategy!,
      mode: "manual_verification",
      existingTestEvidence: [
        {
          id: "no-test-surface",
          kind: "no_suitable_test_surface",
          summary: "Planner inspected local test directories and found no suitable surface.",
          supportingEvidence: ["Glob found no matching test files."],
        },
      ],
      plannedAutomatedTests: [],
      manualChecks: [
        {
          id: "manual-1",
          relatedSpecIds: ["SPEC-1"],
          scenario: "Inspect the UI with synthetic member data.",
          steps: ["Open the member search UI.", "Confirm the cancel button style."],
          expectedResult: "The cancel button is visible and styled.",
          reasonNotAutomated: "No suitable test surface exists.",
        },
      ],
      coverageGaps: [
        {
          id: "gap-1",
          relatedSpecIds: ["SPEC-1"],
          gap: "No automated UI harness covers this view.",
          reason: "Existing repo tests do not instantiate the GWT screen.",
          risk: "Visual regression could be missed.",
          followUp: "Use manual verification and add automation if the harness appears later.",
        },
      ],
    };

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "testing_adequacy_without_evidence",
          severity: "high",
        }),
      ]),
    );
  });

  it("blocks testing adequacy not_applicable for manual-only code-change plans", () => {
    const plan = buildValidPlan();
    plan.testingStrategy = {
      ...plan.testingStrategy!,
      mode: "manual_verification",
      existingTestEvidence: [
        {
          id: "no-test-surface",
          kind: "no_suitable_test_surface",
          summary: "Planner inspected local test directories and found no suitable surface.",
          supportingEvidence: ["Glob found no matching test files."],
        },
      ],
      plannedAutomatedTests: [],
      manualChecks: [
        {
          id: "manual-1",
          relatedSpecIds: ["SPEC-1"],
          scenario: "Inspect the UI with synthetic member data.",
          steps: ["Open the member search UI.", "Confirm the cancel button style."],
          expectedResult: "The cancel button is visible and styled.",
          reasonNotAutomated: "No suitable test surface exists.",
        },
      ],
      coverageGaps: [
        {
          id: "gap-1",
          relatedSpecIds: ["SPEC-1"],
          gap: "No automated UI harness covers this view.",
          reason: "Existing repo tests do not instantiate the GWT screen.",
          risk: "Visual regression could be missed.",
          followUp: "Use manual verification and add automation if the harness appears later.",
        },
      ],
    };
    plan.guardrailReport!.coreChecks = plan.guardrailReport!.coreChecks.map(
      (check) =>
        check.id === "testing-adequacy"
          ? {
              ...check,
              status: "not_applicable",
              evidence: ["No suitable test surface found."],
              requiredAction: "No action required.",
            }
          : check,
    );

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "testing_adequacy_without_evidence",
          severity: "high",
        }),
      ]),
    );
  });

  it("accepts manual-only plans when testing adequacy is a warning with explicit no-test-surface evidence", () => {
    const plan = buildValidPlan();
    plan.testingStrategy = {
      ...plan.testingStrategy!,
      mode: "manual_verification",
      existingTestEvidence: [
        {
          id: "no-test-surface",
          kind: "no_suitable_test_surface",
          summary: "Planner inspected local test directories and found no suitable surface.",
          supportingEvidence: ["Glob found no matching test files."],
        },
      ],
      plannedAutomatedTests: [],
      manualChecks: [
        {
          id: "manual-1",
          relatedSpecIds: ["SPEC-1"],
          scenario: "Inspect the UI with synthetic member data.",
          steps: ["Open the member search UI.", "Confirm the cancel button style."],
          expectedResult: "The cancel button is visible and styled.",
          reasonNotAutomated: "No suitable test surface exists.",
        },
      ],
      coverageGaps: [
        {
          id: "gap-1",
          relatedSpecIds: ["SPEC-1"],
          gap: "No automated UI harness covers this view.",
          reason: "Existing repo tests do not instantiate the GWT screen.",
          risk: "Visual regression could be missed.",
          followUp: "Use manual verification and add automation if the harness appears later.",
        },
      ],
    };
    plan.guardrailReport!.coreChecks = plan.guardrailReport!.coreChecks.map(
      (check) =>
        check.id === "testing-adequacy"
          ? {
              ...check,
              status: "warning",
              evidence: ["No suitable test surface found; manual checks and coverage gap are explicit."],
              requiredAction: "Implementer must run the manual check and document any deviation.",
            }
          : check,
    );

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
    });

    expect(result.passed).toBe(true);
  });

  it("treats an empty required implementer guardrail file list as all editable files", () => {
    const plan = buildValidPlan();
    plan.implementerGuardrails = [
      {
        id: "all-editable-files",
        instruction: "Apply the approved implementation contract to every editable file.",
        appliesToFiles: [],
        required: true,
      },
    ];

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
    });

    expect(result.passed).toBe(true);
  });

  it("normalizes implementer guardrail paths before checking editable file coverage", () => {
    const workspacePath = "/tmp/oneshot-workspace";
    const plan = buildValidPlan();
    plan.implementerGuardrails = [
      {
        id: "normalized-paths",
        instruction: "Apply guardrails to every editable file.",
        appliesToFiles: [
          "./MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
          "/MedicalMgmt/src/main/webapp/Medhok3.css",
          `${workspacePath}/MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java`,
        ],
        required: true,
      },
    ];

    const result = validateOneShotPlanContract(plan, {
      processingMode: "standard",
      workspacePath,
    });

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });
});

describe("validateImplementedFilesAgainstPlanContract", () => {
  it("allows changed files inside the editable file contract", () => {
    const result = validateImplementedFilesAgainstPlanContract(
      buildValidPlan(),
      ["MedicalMgmt/src/main/webapp/Medhok3.css"],
    );

    expect(result.passed).toBe(true);
  });

  it("blocks changed files outside the editable file contract", () => {
    const result = validateImplementedFilesAgainstPlanContract(
      buildValidPlan(),
      [
        "MedicalMgmt/src/main/webapp/Medhok3.css",
        "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
      ],
    );

    expect(result.passed).toBe(false);
    expect(result.violatingFiles).toEqual([
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
    ]);
  });

  it("normalizes cosmetic path differences before enforcing the editable contract", () => {
    const workspacePath = "/tmp/oneshot-workspace";
    const validateWithWorkspace =
      validateImplementedFilesAgainstPlanContract as unknown as (
        plan: ReturnType<typeof buildValidPlan>,
        changedFiles: readonly string[],
        workspacePath?: string,
      ) => ReturnType<typeof validateImplementedFilesAgainstPlanContract>;

    const result = validateWithWorkspace(
      buildValidPlan(),
      [
        "./MedicalMgmt/src/main/webapp/Medhok3.css",
        `${workspacePath}/MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java`,
        "\\MedicalMgmt\\src\\test\\java\\com\\medhok\\mm\\client\\member\\MemberSearchFormTest.java",
      ],
      workspacePath,
    );

    expect(result.passed).toBe(true);
    expect(result.violatingFiles).toEqual([]);
  });
});

describe("validateImplementedFilesAgainstPlanContract — retrofit allowlist scenarios", () => {
  function buildRetrofitPlan(touchedFiles: string[]) {
    return parseOneShotPlan({
      jiraKey: "CPDEV-25333",
      repoName: "core-app",
      branchName: "medhok-monorepo-3.17",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Retrofit fix.",
      implementationMode: "code_change",
      specs: [
        {
          id: "SPEC-1",
          objective: "Apply source patch.",
          acceptanceCriteria: ["Change applied."],
          targetFiles: touchedFiles,
          implementationNotes: ["Follow source patch."],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: touchedFiles.map((f) => ({
        path: f,
        role: "runtime_required" as const,
        editable: true,
        rationale: "Source-touched file.",
        supportingEvidence: [],
        allowedChanges: ["Apply source change."],
      })),
      testingStrategy: {
        mode: "test_first" as const,
        existingTestEvidence: [],
        plannedAutomatedTests: [],
        validationCommands: [],
        manualChecks: [],
        traceGuidance: [],
        coverageGaps: [],
      },
      guardrailReport: {
        coreChecks: CORE_GUARDRAIL_IDS.map((id) => ({
          id,
          severity: "high" as const,
          status: "passed" as const,
          applicabilityReason: "Core guardrail.",
          evidence: [],
          requiredAction: "None.",
        })),
        domainChecks: [],
        implementerChecks: [],
      },
    });
  }

  it("passes when all changed files are within the retrofit allowlist (source touchedFiles)", () => {
    const allowedFiles = [
      "src/AuthClient.ts",
      "src/AuthClient.test.ts",
    ];
    const plan = buildRetrofitPlan(allowedFiles);
    const result = validateImplementedFilesAgainstPlanContract(plan, allowedFiles);
    expect(result.passed).toBe(true);
    expect(result.violatingFiles).toEqual([]);
  });

  it("rejects files outside the retrofit allowlist", () => {
    const allowedFiles = ["src/AuthClient.ts"];
    const plan = buildRetrofitPlan(allowedFiles);
    const changedFiles = ["src/AuthClient.ts", "src/UnrelatedService.ts"];
    const result = validateImplementedFilesAgainstPlanContract(plan, changedFiles);
    expect(result.passed).toBe(false);
    expect(result.violatingFiles).toContain("src/UnrelatedService.ts");
    expect(result.violatingFiles).not.toContain("src/AuthClient.ts");
  });

  it("allows adaptation files when they are explicitly listed in the allowlist", () => {
    const allowedFiles = [
      "src/AuthClient.ts",
      "src/AdaptedHelper.ts", // explicitly justified adaptation file
    ];
    const plan = buildRetrofitPlan(allowedFiles);
    const changedFiles = ["src/AuthClient.ts", "src/AdaptedHelper.ts"];
    const result = validateImplementedFilesAgainstPlanContract(plan, changedFiles);
    expect(result.passed).toBe(true);
    expect(result.violatingFiles).toEqual([]);
  });
});
