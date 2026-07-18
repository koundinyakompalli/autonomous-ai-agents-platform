import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import {
  CORE_GUARDRAIL_IDS,
  ONE_SHOT_PLAN_OUTPUT_SCHEMA,
  getPlanImpactedFiles,
  getPlanEditableFiles,
  getPlanValidationSteps,
  isVerificationOnlyPlan,
  parseRetrofitAlreadyAppliedEvidence,
  parseOneShotPlan,
  plannerDiscoveriesWereSanitized,
  repairOneShotStructuredPlanOutput,
  sanitizePlannerDiscoveries,
} from "./plan.js";

describe("parseOneShotPlan", () => {
  const plan = parseOneShotPlan({
    jiraKey: "CPDEV-1",
    repoName: "core-app",
    branchName: "master",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "Implement the approved PFOS change.",
    specs: [
      {
        id: "SPEC-1",
        objective: "Update the queue consumer wiring",
        acceptanceCriteria: ["Queue consumer starts successfully"],
        targetFiles: ["src/oneshot/main.ts", "src/oneshot/provider.ts"],
        implementationNotes: ["Follow existing startup patterns"],
        validationSteps: ["npm run build"],
      },
      {
        id: "SPEC-2",
        objective: "Add integration coverage",
        acceptanceCriteria: ["Integration test covers queue startup"],
        targetFiles: [
          "src/oneshot/main.ts",
          "src/oneshot/e2e/pipeline.integration.test.ts",
        ],
        implementationNotes: ["Reuse the existing LocalStack test scaffolding"],
        validationSteps: [
          "npm test -- --run src/oneshot/e2e/pipeline.integration.test.ts",
        ],
      },
    ],
    assumptions: [],
    openQuestions: [],
    outOfScope: [],
    risks: [],
  });

  function requiredContractSections(targetFiles: string[]) {
    const testFile =
      targetFiles.find((file) => /(?:^|\/)(?:test|__tests__|spec)(?:\/|$)|(?:test|spec)\.[jt]sx?$|Test\.java$/i.test(file)) ??
      "src/oneshot/schema/plan.test.ts";
    return {
      fileChangeContract: targetFiles.map((file) => ({
        path: file,
        role: file.includes("/test/") ? "test_required" : "runtime_required",
        editable: true,
        rationale: `The plan targets ${file}.`,
        supportingEvidence: [`Planner inspected ${file}.`],
        allowedChanges: ["Apply the localized planned update."],
      })),
      plannedCodeChanges: targetFiles.slice(0, 2).map((file) => ({
        targetFile: file,
        symbolOrRegion: "localized planned change",
        changeType: "update",
        afterSketch: "Apply the targeted implementation described by the spec.",
        rationale: "Representative schema fixture includes a code sketch.",
        supportingEvidence: [`Planner inspected ${file}.`],
        confidence: "medium",
      })),
      guardrailReport: {
        coreChecks: CORE_GUARDRAIL_IDS.map((id) => ({
          id,
          severity: "high",
          status: "passed",
          applicabilityReason: "Core guardrail applies to every plan.",
          evidence: ["Representative fixture contains explicit contract data."],
          requiredAction: "Implementer must preserve this guardrail.",
        })),
        domainChecks: [
          {
            id: "pfos-security-remediation-scope",
            severity: "high",
            status: "not_applicable",
            applicabilityReason:
              "Representative fixture is not CVE/package remediation.",
            evidence: ["No PFOS evidence in fixture."],
            requiredAction: "Do not apply PFOS-only scope.",
          },
        ],
        implementerChecks: [
          {
            id: "editable-file-contract",
            severity: "high",
            status: "passed",
            applicabilityReason: "Editable files are explicit.",
            evidence: ["fileChangeContract is populated."],
            requiredAction: "Stay inside editable files.",
          },
        ],
      },
      testingStrategy: {
        mode: "test_first",
        existingTestEvidence: [
          {
            id: "evidence-existing-test",
            kind: "test_file",
            path: testFile,
            summary: "Planner inspected the nearest existing test surface.",
            supportingEvidence: [`Read ${testFile}.`],
          },
        ],
        plannedAutomatedTests: [
          {
            id: "AUTO-SPEC-1",
            testFile,
            relatedSpecIds: ["SPEC-1"],
            testType: "unit",
            scenario: "Covers the primary planned behavior before runtime edits.",
            assertions: ["Expected behavior is asserted with synthetic data."],
            failFirst: true,
            command: "npm test -- src/oneshot/schema/plan.test.ts",
            syntheticDataNotes: "Use synthetic fixture values only.",
          },
        ],
        validationCommands: [
          {
            command: "npm test -- src/oneshot/schema/plan.test.ts",
            expectedResult: "Focused plan schema tests pass.",
            scope: "focused",
            relatedSpecIds: ["SPEC-1"],
          },
        ],
        manualChecks: [],
        traceGuidance: [
          {
            id: "TRACE-SPEC-1",
            section: "C",
            testType: "Unit",
            scenario: "Generate a unit test case from the planned automated test.",
            relatedSpecIds: ["SPEC-1"],
            priority: "High",
          },
        ],
        coverageGaps: [],
      },
      implementerGuardrails: [
        {
          id: "fixture-file-scope",
          instruction: "Edit only files listed as editable.",
          appliesToFiles: targetFiles,
          required: true,
        },
      ],
    };
  }

  it("derives distinct impacted files from plan specs", () => {
    expect(getPlanImpactedFiles(plan)).toEqual([
      "src/oneshot/main.ts",
      "src/oneshot/provider.ts",
      "src/oneshot/e2e/pipeline.integration.test.ts",
    ]);
  });

  it("derives distinct validation steps from plan specs", () => {
    expect(getPlanValidationSteps(plan)).toEqual([
      "npm run build",
      "npm test -- --run src/oneshot/e2e/pipeline.integration.test.ts",
    ]);
  });

  it("keeps target-file rationales optional for existing plans", () => {
    expect(plan.specs[0].targetFileRationales).toEqual([]);
  });

  it("defaults missing implementationMode to code_change", () => {
    expect(plan.implementationMode).toBe("code_change");
  });

  it("parses PRISM-style file contracts, code sketches, and guardrail reports", () => {
    const parsed = parseOneShotPlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Add the cancel button affordance with scoped MedHOK styling.",
      implementationMode: "code_change",
      specs: [
        {
          id: "SPEC-1",
          objective: "Render and style the cancel button.",
          acceptanceCriteria: ["Cancel button is visible and styled red."],
          targetFiles: [
            "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
            "MedicalMgmt/src/main/webapp/Medhok3.css",
          ],
          implementationNotes: ["Use the existing cs-secondary-button pattern."],
          validationSteps: ["mvn -pl MedicalMgmt -DskipTests compile"],
        },
      ],
      fileChangeContract: [
        {
          path: "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
          role: "runtime_required",
          editable: true,
          rationale: "The Java view creates the member search controls.",
          supportingEvidence: [
            "Read MemberSearchForm.java around the existing button setup.",
          ],
          allowedChanges: ["Insert the cancel button next to existing controls."],
        },
        {
          path: "MedicalMgmt/src/main/webapp/Medhok3.css",
          role: "runtime_required",
          editable: true,
          rationale: "The page loads the root Medhok3.css runtime stylesheet.",
          supportingEvidence: ["Read index.html and Medhok3.css."],
          allowedChanges: ["Add the localized cs-cancel-button style block."],
        },
        {
          path: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csSecondaryButton.scss",
          role: "read_only_evidence",
          editable: false,
          rationale: "Sibling source style establishes the naming pattern.",
          supportingEvidence: ["Read _csSecondaryButton.scss."],
        },
      ],
      plannedCodeChanges: [
        {
          targetFile:
            "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
          symbolOrRegion: "createSearchButtons() button construction",
          changeType: "insert",
          beforeSnippet: "buttonPanel.add(searchButton);",
          afterSketch:
            "Button cancelButton = new Button(constants.cancel());\ncancelButton.addStyleName(\"cs-cancel-button\");\nbuttonPanel.add(cancelButton);",
          rationale: "Keep the new control adjacent to existing actions.",
          supportingEvidence: ["Existing search button setup in MemberSearchForm.java."],
          confidence: "high",
        },
      ],
      guardrailReport: {
        coreChecks: CORE_GUARDRAIL_IDS.map((id) => ({
          id,
          severity: "high",
          status: "passed",
          applicabilityReason: "Core guardrail applies to every OneShot plan.",
          evidence: ["Plan file contract and validation steps were inspected."],
          requiredAction: "Implementer must preserve this guardrail.",
        })),
        domainChecks: [
          {
            id: "pfos-security-remediation-scope",
            severity: "high",
            status: "not_applicable",
            applicabilityReason:
              "Ticket evidence describes UI button styling, not CVE/package remediation.",
            evidence: ["Ticket summary references UI styling."],
            requiredAction:
              "Do not apply pom.xml-only PFOS remediation scope to this UI plan.",
          },
        ],
        implementerChecks: [
          {
            id: "editable-file-contract",
            severity: "high",
            status: "passed",
            applicabilityReason:
              "Implementation must stay inside runtime editable files.",
            evidence: ["fileChangeContract marks the Java and CSS files editable."],
            requiredAction:
              "Only edit files marked editable in fileChangeContract.",
          },
        ],
      },
      implementerGuardrails: [
        {
          id: "member-search-file-scope",
          instruction:
            "Edit only the Java and loaded runtime CSS files unless returning a deviation.",
          appliesToFiles: [
            "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
            "MedicalMgmt/src/main/webapp/Medhok3.css",
          ],
          required: true,
        },
      ],
      testingStrategy: {
        mode: "focused_regression",
        existingTestEvidence: [
          {
            id: "member-search-existing-test",
            kind: "test_file",
            path: "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java",
            summary: "Nearest member-search test surface for UI behavior.",
            supportingEvidence: ["Glob found existing member search test conventions."],
          },
        ],
        plannedAutomatedTests: [
          {
            id: "AUTO-SPEC-1",
            testFile:
              "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java",
            relatedSpecIds: ["SPEC-1"],
            testType: "unit",
            scenario: "Cancel button is added with the expected style name.",
            assertions: ["Button style includes cs-cancel-button."],
            failFirst: true,
            command:
              "mvn -pl MedicalMgmt -Dtest=MemberSearchFormTest test",
            syntheticDataNotes: "Use synthetic UI fixtures only.",
          },
        ],
        validationCommands: [
          {
            command: "mvn -pl MedicalMgmt -DskipTests compile",
            expectedResult: "MedicalMgmt compiles after UI changes.",
            scope: "focused",
            relatedSpecIds: ["SPEC-1"],
          },
        ],
        manualChecks: [
          {
            id: "MANUAL-SPEC-1",
            relatedSpecIds: ["SPEC-1"],
            scenario: "Inspect the member search UI button color.",
            steps: ["Open member search with synthetic data.", "Confirm cancel button is red."],
            expectedResult: "Cancel button follows the approved red style.",
            reasonNotAutomated: "Visual color check may require manual UI inspection.",
          },
        ],
        traceGuidance: [
          {
            id: "TRACE-CANCEL-BUTTON",
            section: "C",
            testType: "Unit",
            scenario: "Unit coverage for cancel button style assignment.",
            relatedSpecIds: ["SPEC-1"],
            priority: "High",
          },
        ],
        coverageGaps: [],
      },
    });

    expect(getPlanEditableFiles(parsed)).toEqual([
      "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
      "MedicalMgmt/src/main/webapp/Medhok3.css",
    ]);
    expect(parsed.plannedCodeChanges?.[0]).toMatchObject({
      targetFile:
        "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
      changeType: "insert",
      confidence: "high",
    });
    expect(parsed.guardrailReport?.domainChecks[0]).toMatchObject({
      id: "pfos-security-remediation-scope",
      status: "not_applicable",
    });
    expect(parsed.testingStrategy?.plannedAutomatedTests[0]).toMatchObject({
      id: "AUTO-SPEC-1",
      failFirst: true,
      testType: "unit",
    });
  });

  it("detects structured verification-only plans", () => {
    const parsed = parseOneShotPlan({
      jiraKey: "CPDEV-23568",
      repoName: "core-app",
      branchName: "medhok-monorepo-3.19",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Verify log4j remediation is already applied.",
      implementationMode: "verification_only",
      specs: [
        {
          id: "SPEC-1",
          objective: "Confirm the dependency remediation is already present.",
          acceptanceCriteria: ["No repository change is required."],
          targetFiles: ["pom.xml"],
          implementationNotes: ["Inspect dependency versions only."],
          validationSteps: ["mvn -q -DskipTests dependency:tree"],
        },
      ],
    });

    expect(isVerificationOnlyPlan(parsed)).toBe(true);
  });

  it("detects conservative legacy verification-only plan text", () => {
    const parsed = parseOneShotPlan({
      jiraKey: "CPDEV-23437",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Confirm no UI change is required for Appeals Get Next sort.",
      specs: [
        {
          id: "SPEC-1",
          objective: "Verify the existing sort behavior already satisfies the ticket.",
          acceptanceCriteria: ["No UI changes are required."],
          targetFiles: ["MedicalMgmt/src/main/webapp/AppealsGetNext.tsx"],
          implementationNotes: ["Use inspected UI behavior as evidence."],
          validationSteps: ["npm test -- AppealsGetNext"],
        },
      ],
    });

    expect(isVerificationOnlyPlan(parsed)).toBe(true);
  });

  it("does not let legacy text override explicit code_change mode", () => {
    const parsed = parseOneShotPlan({
      jiraKey: "CPDEV-23437",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "No code changes required for the existing helper; update the queue wiring.",
      implementationMode: "code_change",
      specs: [
        {
          id: "SPEC-1",
          objective: "Update queue wiring while preserving the existing helper.",
          acceptanceCriteria: ["Queue wiring is updated."],
          targetFiles: ["src/queue.ts"],
          implementationNotes: ["Use the helper that is already present."],
          validationSteps: ["npm test -- queue"],
        },
      ],
    });

    expect(parsed.implementationMode).toBe("code_change");
    expect(isVerificationOnlyPlan(parsed)).toBe(false);
  });

  it("does not infer legacy verification-only from open questions", () => {
    const parsed = parseOneShotPlan({
      jiraKey: "CPDEV-23437",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Implement the approved sort behavior change.",
      specs: [
        {
          id: "SPEC-1",
          objective: "Update the backend sort behavior.",
          acceptanceCriteria: ["Sort behavior is updated."],
          targetFiles: ["src/sort-service.ts"],
          implementationNotes: ["Follow existing sort service patterns."],
          validationSteps: ["npm test -- sort-service"],
        },
      ],
      openQuestions: ["Confirm no code changes required?"],
    });

    expect(isVerificationOnlyPlan(parsed)).toBe(false);
  });

  it("does not treat a no-UI-change acceptance criterion as no-action by itself", () => {
    const parsed = parseOneShotPlan({
      jiraKey: "CPDEV-23437",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Implement backend sorting without changing the UI.",
      specs: [
        {
          id: "SPEC-1",
          objective: "Update backend multi-criteria sort.",
          acceptanceCriteria: [
            "Backend sort criteria are applied.",
            "No UI changes are required.",
          ],
          targetFiles: ["src/sort-service.ts"],
          implementationNotes: ["Edit backend sorting only."],
          validationSteps: ["npm test -- sort-service"],
        },
      ],
    });

    expect(isVerificationOnlyPlan(parsed)).toBe(false);
  });

  it("parses retrofit evidence in planner discoveries", () => {
    const parsed = parseOneShotPlan({
      jiraKey: "CPDEV-1",
      repoName: "batch-jobs",
      branchName: "batch-monorepo-3.18",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Retrofit source change.",
      specs: [
        {
          id: "SPEC-1",
          objective: "Reapply missing config change",
          acceptanceCriteria: ["Config exists on target"],
          targetFiles: ["mm-member-merge/src/main/resources/jbpm.cfg.xml"],
          implementationNotes: ["Reapply source commit abc1234"],
          validationSteps: ["mvn test"],
        },
      ],
      plannerDiscoveries: {
        entryPoints: [],
        relevantPatterns: [],
        keyDependencies: [],
        retrofitEvidence: {
          sourceJiraKey: "CPDEV-1234",
          sourceBranch: "batch-monorepo-master",
          targetBranch: "batch-monorepo-3.18",
          selectedCommits: [
            {
              sha: "abcdef1234567890",
              subject: "CPDEV-1234 add jbpm config",
              files: ["mm-member-merge/src/main/resources/jbpm.cfg.xml"],
              alreadyApplied: false,
            },
          ],
          touchedFiles: ["mm-member-merge/src/main/resources/jbpm.cfg.xml"],
          alreadyApplied: false,
          evidenceSummary: "Source commit is missing on target.",
        },
      },
    });

    expect(
      parsed.plannerDiscoveries?.retrofitEvidence?.sourceJiraKey,
    ).toBe("CPDEV-1234");
  });

  it("normalizes blank optional retrofit URL fields before parsing", () => {
    const parsed = parseOneShotPlan(
      sanitizePlannerDiscoveries({
        jiraKey: "CPDEV-25656",
        repoName: "core-app",
        branchName: "medhok-monorepo-3.20",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Retrofit source logging into the target branch.",
        implementationMode: "code_change",
        specs: [
          {
            id: "retrofit-logging",
            objective: "Adapt the source logging patch.",
            acceptanceCriteria: ["The source log line exists twice."],
            targetFiles: [
              "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
            ],
            implementationNotes: ["Apply the source patch by target anchor."],
            validationSteps: ["mvn -f MedicalMgmt/pom.xml -DskipTests compile"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
        plannerDiscoveries: {
          retrofitEvidence: {
            sourceJiraKey: "CPDEV-25644",
            sourceBranch: "medhok-monorepo-3.19",
            targetBranch: "medhok-monorepo-3.20",
            sourcePrUrl: "",
            commitSelectionMethod: "commit_pr_expansion",
            sourceCommitSelectionComplete: true,
            selectedCommits: [
              {
                sha: "3df02e6dba78bee989116b3e709be6bc2e6a7ef1",
                subject: "CPDEV-25644 Log legacy auto assignment claims",
                files: [
                  "MedicalMgmt/src/com/medhok/mm/server/service/MedicalMgmtService.java",
                ],
                alreadyApplied: false,
              },
            ],
            touchedFiles: [
              "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
            ],
            alreadyApplied: false,
            evidenceSummary: "Source patch is missing from target.",
          },
          retrofitExecutionContract: {
            version: "retrofit_execution_contract.v1",
            sourceJiraKey: "CPDEV-25644",
            sourceRepoName: "core-app",
            sourceRepoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
            sourceBranch: "medhok-monorepo-3.19",
            targetBranch: "medhok-monorepo-3.20",
            sourcePrUrl: " ",
            commitSelectionMethod: "commit_pr_expansion",
            sourceCommitSelectionComplete: true,
            selectedCommits: [
              {
                sha: "3df02e6dba78bee989116b3e709be6bc2e6a7ef1",
                subject: "CPDEV-25644 Log legacy auto assignment claims",
                status: "adapted",
                sourceFiles: [
                  "MedicalMgmt/src/com/medhok/mm/server/service/MedicalMgmtService.java",
                ],
                targetFiles: [
                  "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
                ],
                adaptationFiles: [
                  "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
                ],
                rationale: "Adapt source layout to target Maven layout.",
                conflictDiagnostics: "",
                proofSnippets: ["Source log line mapped to target anchor."],
                validationEvidence: ["Compile target module."],
              },
            ],
            allowedFileMappings: [
              {
                sourceSha: "3df02e6dba78bee989116b3e709be6bc2e6a7ef1",
                sourceFiles: [
                  "MedicalMgmt/src/com/medhok/mm/server/service/MedicalMgmtService.java",
                ],
                targetFiles: [
                  "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
                ],
                adaptationFiles: [
                  "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
                ],
                rationale: "Source path maps to target source root.",
                evidence: ["Read target anchor."],
              },
            ],
          },
        },
        fileChangeContract: [
          {
            path: "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
            role: "runtime_required",
            editable: true,
            rationale: "Target file for source SHA 3df02e6.",
            supportingEvidence: ["Source SHA 3df02e6 touched the logical file."],
            allowedChanges: ["Insert source logging line."],
          },
        ],
      }).value,
    );

    expect(parsed.plannerDiscoveries?.retrofitEvidence?.sourcePrUrl).toBeUndefined();
    expect(
      parsed.plannerDiscoveries?.retrofitExecutionContract?.sourcePrUrl,
    ).toBeUndefined();
    expect(
      parsed.plannerDiscoveries?.retrofitExecutionContract?.selectedCommits[0]
        .conflictDiagnostics,
    ).toBeUndefined();
    expect(
      parsed.plannerDiscoveries?.retrofitExecutionContract?.selectedCommits[0]
        .status,
    ).toBe("adapted");
  });

  it("rejects empty optional retrofit URLs at the planner JSON schema boundary", () => {
    const validate = new Ajv().compile(ONE_SHOT_PLAN_OUTPUT_SCHEMA);
    const output = {
      jiraKey: "CPDEV-25656",
      repoName: "core-app",
      branchName: "medhok-monorepo-3.20",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Retrofit source logging into the target branch.",
      implementationMode: "code_change",
      specs: [
        {
          id: "retrofit-logging",
          objective: "Adapt the source logging patch.",
          acceptanceCriteria: ["The source log line exists twice."],
          targetFiles: [
            "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
          ],
          implementationNotes: ["Apply the source patch by target anchor."],
          validationSteps: ["mvn -f MedicalMgmt/pom.xml -DskipTests compile"],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
      ...requiredContractSections([
        "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
      ]),
      plannerDiscoveries: {
        retrofitEvidence: {
          sourceJiraKey: "CPDEV-25644",
          sourceBranch: "medhok-monorepo-3.19",
          targetBranch: "medhok-monorepo-3.20",
          sourcePrUrl: "",
          selectedCommits: [],
          touchedFiles: [],
          alreadyApplied: false,
          evidenceSummary: "Source patch is missing from target.",
        },
      },
    };

    expect(validate(output)).toBe(false);
    expect(
      validate.errors?.some((error) =>
        JSON.stringify(error).includes("sourcePrUrl"),
      ),
    ).toBe(true);
  });

  it("parses already-applied retrofit evidence without plan specs", () => {
    const evidence = parseRetrofitAlreadyAppliedEvidence({
      jiraKey: "CPDEV-9999",
      repoName: "batch-jobs",
      branchName: "batch-monorepo-3.18",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Retrofit already applied.",
      specs: [],
      plannerDiscoveries: {
        retrofitEvidence: {
          sourceJiraKey: "CPDEV-1234",
          sourceBranch: "batch-monorepo-master",
          targetBranch: "batch-monorepo-3.18",
          selectedCommits: [
            {
              sha: "abcdef1234567890",
              subject: "CPDEV-1234 add jbpm config",
              files: ["mm-member-merge/src/main/resources/jbpm.cfg.xml"],
              alreadyApplied: true,
            },
          ],
          touchedFiles: ["mm-member-merge/src/main/resources/jbpm.cfg.xml"],
          alreadyApplied: true,
          evidenceSummary: "Source commit is already present on target.",
        },
      },
    });

    expect(evidence).toMatchObject({
      sourceJiraKey: "CPDEV-1234",
      alreadyApplied: true,
    });
  });

  it("parses target-file rationales when the planner provides them", () => {
    const parsed = parseOneShotPlan({
      jiraKey: "CPDEV-1",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create adjacent Sass partial.",
      specs: [
        {
          id: "SPEC-1",
          objective: "Create cancel button style",
          acceptanceCriteria: ["Cancel button has red style"],
          targetFiles: [
            "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
          ],
          targetFileRationales: [
            {
              targetFile:
                "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
              rationale:
                "Existing custom button partials establish the adjacent style pattern.",
              supportingFiles: [
                "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
              ],
              rejectedAlternatives: [
                "Do not edit generated skin_styles.css directly.",
              ],
            },
          ],
          implementationNotes: [
            "Follow the existing custom Sass partial naming pattern.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
    });

    expect(parsed.specs[0].targetFileRationales[0]).toMatchObject({
      rationale:
        "Existing custom button partials establish the adjacent style pattern.",
      supportingFiles: [
        "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
      ],
    });
  });

  it("sanitizes verbose planner discoveries before schema validation", () => {
    const oversized = "x".repeat(1500);
    const { value, report } = sanitizePlannerDiscoveries({
      jiraKey: "CPDEV-1",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Implement the approved PFOS change.",
      specs: [
        {
          id: "SPEC-1",
          objective: "Update planner discoveries",
          acceptanceCriteria: ["Verbose discoveries are truncated"],
          targetFiles: ["src/oneshot/schema/plan.ts"],
          implementationNotes: ["Sanitize before parse"],
          validationSteps: ["npm test"],
        },
      ],
      plannerDiscoveries: {
        relevantPatterns: Array.from({ length: 12 }, (_, index) =>
          index === 0 ? oversized : `pattern-${index}`,
        ),
        entryPoints: ["", "src/oneshot/schema/plan.ts"],
        keyDependencies: ["zod"],
      },
    });

    expect(plannerDiscoveriesWereSanitized(report)).toBe(true);
    expect(report.truncatedFields[0]).toMatchObject({
      path: "plannerDiscoveries.relevantPatterns[0]",
      originalLength: 1500,
      cap: 1000,
    });
    expect(report.droppedArrayEntries).toBe(2);
    const parsed = parseOneShotPlan(value);
    expect(parsed.plannerDiscoveries?.relevantPatterns).toHaveLength(10);
    expect(parsed.plannerDiscoveries?.relevantPatterns[0]).toHaveLength(1000);
    expect(parsed.plannerDiscoveries?.entryPoints).toEqual([
      "src/oneshot/schema/plan.ts",
    ]);
  });

  it("requires new planner outputs to include explicit contract and guardrail sections", () => {
    const validate = new Ajv().compile(ONE_SHOT_PLAN_OUTPUT_SCHEMA);

    expect(
      validate({
        jiraKey: "CPDEV-1",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Implement the approved PFOS change.",
        implementationMode: "code_change",
        specs: [
          {
            id: "SPEC-1",
            objective: "Update the queue consumer wiring",
            acceptanceCriteria: ["Queue consumer starts successfully"],
            targetFiles: ["src/oneshot/main.ts"],
            implementationNotes: ["Follow existing startup patterns"],
            validationSteps: ["npm run build"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("requires new planner outputs to include an explicit testing strategy", () => {
    const validate = new Ajv().compile(ONE_SHOT_PLAN_OUTPUT_SCHEMA);
    const output = {
      jiraKey: "CPDEV-1",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Implement the approved change.",
      implementationMode: "code_change",
      specs: [
        {
          id: "SPEC-1",
          objective: "Update the queue consumer wiring",
          acceptanceCriteria: ["Queue consumer starts successfully"],
          targetFiles: ["src/oneshot/main.ts"],
          implementationNotes: ["Follow existing startup patterns"],
          validationSteps: ["npm run build"],
        },
      ],
      ...requiredContractSections(["src/oneshot/main.ts"]),
    };
    delete (output as { testingStrategy?: unknown }).testingStrategy;

    expect(validate(output)).toBe(false);
    expect(validate.errors?.some((error) => error.params && JSON.stringify(error.params).includes("testingStrategy"))).toBe(true);
  });

  it("rejects planner JSON schema outputs with empty required arrays or strings", () => {
    const validate = new Ajv().compile(ONE_SHOT_PLAN_OUTPUT_SCHEMA);

    expect(
      validate({
        jiraKey: "CPDEV-1",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Implement the approved PFOS change.",
        specs: [
          {
            id: "SPEC-1",
            objective: "",
            acceptanceCriteria: ["Queue consumer starts successfully"],
            targetFiles: [],
            implementationNotes: ["Follow existing startup patterns"],
            validationSteps: ["npm run build"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects planner JSON schema outputs with extra root wrapper fields", () => {
    const validate = new Ajv().compile(ONE_SHOT_PLAN_OUTPUT_SCHEMA);
    const output = {
      jiraKey: "CPDEV-1",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Implement the approved grounded change.",
      implementationMode: "code_change",
      specs: [
        {
          id: "SPEC-1",
          objective: "Update planner schema guidance.",
          acceptanceCriteria: ["Planner emits only allowed root keys."],
          targetFiles: ["src/oneshot/schema/plan.ts"],
          implementationNotes: ["Keep the root plan envelope strict."],
          validationSteps: ["npm test -- src/oneshot/schema/plan.test.ts"],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
      ...requiredContractSections(["src/oneshot/schema/plan.ts"]),
      metadata: {
        title: "Do not wrap OneShot plans.",
      },
    };

    expect(validate(output)).toBe(false);
    expect(
      validate.errors?.some(
        (error) =>
          error.keyword === "additionalProperties" &&
          JSON.stringify(error.params).includes("metadata"),
      ),
    ).toBe(true);
  });

  it("repairs structured output by trimming values and promoting rationale targets", () => {
    const repaired = repairOneShotStructuredPlanOutput({
      jiraKey: " CPDEV-1 ",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: " Implement the approved PFOS change. ",
      specs: [
        {
          id: " SPEC-1 ",
          objective: "Update planner repair.",
          acceptanceCriteria: ["Valid plan remains.", ""],
          targetFiles: [],
          targetFileRationales: [
            {
              targetFile: "src/oneshot/schema/plan.ts",
              rationale: "Planner schema owns plan validation.",
              supportingFiles: ["src/oneshot/schema/plan.test.ts", ""],
            },
          ],
          implementationNotes: ["Use deterministic repair."],
          validationSteps: ["npm test"],
        },
      ],
    });

    const parsed = parseOneShotPlan(repaired.value);

    expect(parsed.jiraKey).toBe("CPDEV-1");
    expect(parsed.specs[0].id).toBe("SPEC-1");
    expect(parsed.specs[0].targetFiles).toEqual(["src/oneshot/schema/plan.ts"]);
    expect(parsed.specs[0].acceptanceCriteria).toEqual(["Valid plan remains."]);
    expect(repaired.report).toMatchObject({
      repaired: true,
      promotedTargetFiles: 1,
      droppedEmptyArrayEntries: 2,
    });
  });

  it("drops unrepairable specs only when a valid repaired spec remains", () => {
    const repaired = repairOneShotStructuredPlanOutput({
      jiraKey: "CPDEV-1",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Implement the approved PFOS change.",
      specs: [
        null,
        {
          id: "SPEC-1",
          objective: "Keep the valid plan spec.",
          acceptanceCriteria: ["Valid spec remains."],
          targetFiles: ["src/oneshot/schema/plan.ts"],
          implementationNotes: ["Do not discard valid adjacent specs."],
          validationSteps: ["npm test"],
        },
      ],
    });

    const parsed = parseOneShotPlan(repaired.value);

    expect(parsed.specs).toHaveLength(1);
    expect(parsed.specs[0].id).toBe("SPEC-1");
    expect(repaired.report).toMatchObject({
      repaired: true,
      droppedSpecs: 1,
    });
  });

  it("accepts a representative plan within the iteration-4 size caps", () => {
    const validate = new Ajv().compile(ONE_SHOT_PLAN_OUTPUT_SCHEMA);

    const realisticPlan = {
      jiraKey: "CPDEV-21565",
      repoName: "interop",
      branchName: "feature/CPDEV-21565-mhk-internal-qr",
      baseCommitSha: "4a2276ad4ec8f05bcd2f0c961834308c0c259466",
      summary:
        "Extend PAS $submit to accept MHK Internal DTR QuestionnaireResponses and translate them to WSQuestionSet objects for the Core API. Remediate PHI-exposing log statements in three files. Includes atomic 3-param signature changes across 4 test files and ~12 new unit tests.",
      implementationMode: "code_change",
      specs: Array.from({ length: 7 }, (_, index) => ({
        id: `SPEC-${index + 1}`,
        objective: `Implement MHK Internal DTR handling slice ${index + 1} with appropriate translation logic and PHI-safe logging.`,
        acceptanceCriteria: [
          "The QuestionnaireResponse.meta.source is correctly detected",
          "The translated WSQuestionSet payload is passed to Core API",
        ],
        targetFiles: [
          `mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/SliceService${index + 1}.java`,
          `mhk-interopt-fhirhelper/src/test/java/com/mhkinterop/fhir/service/SliceService${index + 1}Test.java`,
        ],
        targetFileRationales: [
          {
            targetFile: `mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/SliceService${index + 1}.java`,
            rationale:
              "This service is the entry point for the translation flow; the existing sibling service follows the same pattern of detecting meta.source and routing to the correct builder.",
            supportingFiles: [
              `mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/UmPriorAuthorizationService.java`,
            ],
          },
        ],
        implementationNotes: [
          'Detect meta.source === "http://mhk.com/fhir/dtr" early in processBundle',
          "Delegate to FhirQuestionnaireResponseToWSQuestionSetBuilder",
        ],
        validationSteps: [
          `mvn -pl mhk-interopt-fhirhelper -Dtest=SliceService${index + 1}Test test`,
        ],
      })),
      assumptions: ["The DTR source URL is stable across environments"],
      openQuestions: [],
      outOfScope: ["Changes to the Core API itself"],
      risks: ["Accidentally masking legitimate non-MHK DTR responses"],
      ...requiredContractSections([
        "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/SliceService1.java",
        "mhk-interopt-fhirhelper/src/test/java/com/mhkinterop/fhir/service/SliceService1Test.java",
      ]),
    };

    const result = validate(realisticPlan);
    if (!result) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    expect(result).toBe(true);
  });

  it("accepts a run-153-style retrofit plan with a long implementation note under the raised cap", () => {
    const validate = new Ajv().compile(ONE_SHOT_PLAN_OUTPUT_SCHEMA);
    const longImplementationNote =
      "Preserve the 3.14 endpoint contract while retrofitting the source behavior: keep the existing request and response DTO names stable, copy only the logic needed for getUmQuestionSet, and adapt service calls to the target branch APIs after checking nearby controller and service patterns. ".repeat(
        5,
      );
    const longRationale =
      "The retrofit endpoint and its service collaborator are the smallest grounded target surface because the source tickets changed getUmQuestionSet behavior without requiring a broad framework migration; adjacent resource tests already exercise the same branch-specific wiring. ".repeat(
        4,
      );

    expect(longImplementationNote.length).toBeGreaterThan(600);
    expect(longImplementationNote.length).toBeLessThan(3000);
    expect(longRationale.length).toBeGreaterThan(800);
    expect(longRationale.length).toBeLessThan(3000);

    const retrofitPlan = {
      jiraKey: "CPDEV-22232",
      repoName: "core-app",
      branchName: "medhok-monorepo-3.14",
      baseCommitSha: "6268ed8625b31f2f84df7bb5e5927b9d2d318322",
      summary:
        "Retrofit the 3.14 getUmQuestionSet endpoint from the source tickets onto the target branch.",
      implementationMode: "code_change",
      specs: Array.from({ length: 5 }, (_, index) => ({
        id: `SPEC-${index + 1}`,
        objective: `Retrofit getUmQuestionSet slice ${index + 1} on the 3.14 branch while preserving existing target-branch contracts.`,
        acceptanceCriteria: [
          "The endpoint behavior matches the source ticket intent on the target branch.",
          "Existing 3.14 callers keep the same public request and response contract.",
        ],
        targetFiles: [
          `MedicalMgmt/src/main/java/com/medhok/um/rest/UmQuestionSetResource${index + 1}.java`,
          `MedicalMgmt/src/test/java/com/medhok/um/rest/UmQuestionSetResource${index + 1}Test.java`,
        ],
        targetFileRationales: [
          {
            targetFile: `MedicalMgmt/src/main/java/com/medhok/um/rest/UmQuestionSetResource${index + 1}.java`,
            rationale: index === 4 ? longRationale : "Endpoint entry point.",
            supportingFiles: [
              "MedicalMgmt/src/main/java/com/medhok/um/service/UmQuestionSetService.java",
            ],
          },
        ],
        implementationNotes: [
          index === 4
            ? longImplementationNote
            : "Follow the adjacent resource and service patterns already present on the 3.14 branch.",
        ],
        validationSteps: [
          `mvn -pl MedicalMgmt -Dtest=UmQuestionSetResource${index + 1}Test test`,
        ],
      })),
      assumptions: [
        "The source ticket behavior is being retrofitted without changing the public target-branch API.",
      ],
      openQuestions: [],
      outOfScope: ["Unrelated question-set endpoint cleanup"],
      risks: [
        "Source and target branch service APIs may differ around question-set lookup defaults.",
      ],
      ...requiredContractSections([
        "MedicalMgmt/src/main/java/com/medhok/um/rest/UmQuestionSetResource1.java",
        "MedicalMgmt/src/test/java/com/medhok/um/rest/UmQuestionSetResource1Test.java",
      ]),
    };

    const result = validate(retrofitPlan);
    if (!result) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    expect(result).toBe(true);
  });

  it("rejects planner JSON schema outputs that exceed the raised size caps", () => {
    const validate = new Ajv().compile(ONE_SHOT_PLAN_OUTPUT_SCHEMA);

    // summary maxLength is 4000; 4001 chars must reject.
    const overCapSummary = "x".repeat(4001);
    expect(
      validate({
        jiraKey: "CPDEV-1",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: overCapSummary,
        specs: [
          {
            id: "SPEC-1",
            objective: "Update the queue consumer wiring",
            acceptanceCriteria: ["Queue consumer starts successfully"],
            targetFiles: ["src/oneshot/main.ts"],
            implementationNotes: ["Follow existing startup patterns"],
            validationSteps: ["npm run build"],
          },
        ],
      }),
    ).toBe(false);
  });
});
