import type { OneShotProcessingMode } from "./processing-mode.js";
import {
  CORE_GUARDRAIL_IDS,
  getPlanEditableFiles,
  getPlanImpactedFiles,
  type OneShotGuardrailCheck,
  type OneShotPlan,
} from "./schema/plan.js";

export interface PlanContractFinding {
  code:
    | "missing_guardrail_report"
    | "missing_core_guardrail_checks"
    | "guardrail_failed"
    | "missing_file_change_contract"
    | "missing_editable_file_contract"
    | "target_files_missing_from_contract"
    | "missing_planned_code_changes"
    | "planned_code_change_outside_contract"
    | "missing_testing_strategy"
    | "planned_test_outside_contract"
    | "planned_test_unknown_spec"
    | "testing_adequacy_without_evidence"
    | "missing_automated_test_or_gap"
    | "missing_implementer_guardrails"
    | "editable_files_missing_implementer_guardrails"
    | "unsupported_pfos_applicability"
    | "missing_pfos_guardrail"
    | "missing_sonar_guardrail";
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  paths?: string[];
  guardrailIds?: string[];
}

export interface PlanContractValidationResult {
  passed: boolean;
  findings: PlanContractFinding[];
}

export interface PlanContractValidationOptions {
  processingMode?: OneShotProcessingMode;
  jiraLabels?: readonly string[];
  workspacePath?: string;
}

export interface ImplementationFileContractResult {
  passed: boolean;
  editableFiles: string[];
  changedFiles: string[];
  violatingFiles: string[];
}

export interface ImplementationFileContractOptions {
  workspacePath?: string;
}

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

function allGuardrailChecks(plan: OneShotPlan): OneShotGuardrailCheck[] {
  const report = plan.guardrailReport;
  if (!report) {
    return [];
  }
  return [
    ...(report.coreChecks ?? []),
    ...(report.domainChecks ?? []),
    ...(report.implementerChecks ?? []),
  ];
}

function matchesGuardrail(check: OneShotGuardrailCheck, pattern: RegExp) {
  return pattern.test(normalizeId(check.id));
}

function findGuardrails(
  plan: OneShotPlan,
  pattern: RegExp,
): OneShotGuardrailCheck[] {
  return allGuardrailChecks(plan).filter((check) =>
    matchesGuardrail(check, pattern),
  );
}

function checkText(check: OneShotGuardrailCheck): string {
  return [
    check.id,
    check.applicabilityReason,
    check.requiredAction,
    ...check.evidence,
  ]
    .join("\n")
    .toLowerCase();
}

function isLabelOnlyApplicability(check: OneShotGuardrailCheck): boolean {
  const text = [check.applicabilityReason, ...check.evidence]
    .join("\n")
    .toLowerCase();
  if (!text.includes("label")) {
    return false;
  }
  return !/(cve|package|dependency|vulnerability|wiz|security remediation|pom\.xml)/i.test(
    text,
  );
}

function requiredCoreGuardrailMissingIds(plan: OneShotPlan): string[] {
  const actual = new Set(
    (plan.guardrailReport?.coreChecks ?? []).map((check) =>
      normalizeId(check.id),
    ),
  );
  return CORE_GUARDRAIL_IDS.filter((id) => !actual.has(id));
}

function testingAdequacyChecks(plan: OneShotPlan): OneShotGuardrailCheck[] {
  return (plan.guardrailReport?.coreChecks ?? []).filter(
    (check) => normalizeId(check.id) === "testing-adequacy",
  );
}

function normalizePlanPath(filePath: string, workspacePath?: string): string {
  let normalized = filePath.trim().replace(/\\/g, "/");
  const normalizedWorkspace = workspacePath
    ?.trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (
    normalizedWorkspace &&
    (normalized === normalizedWorkspace ||
      normalized.startsWith(`${normalizedWorkspace}/`))
  ) {
    normalized = normalized.slice(normalizedWorkspace.length);
  }
  normalized = normalized.replace(/^\/+/, "");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function normalizePlanPaths(
  filePaths: readonly string[],
  workspacePath?: string,
): string[] {
  return Array.from(
    new Set(
      filePaths
        .map((filePath) => normalizePlanPath(filePath, workspacePath))
        .filter(Boolean),
    ),
  );
}

function editableFilesCoveredByGuardrails(
  plan: OneShotPlan,
  workspacePath?: string,
): string[] {
  const requiredGuardrails = (plan.implementerGuardrails ?? []).filter(
    (guardrail) => guardrail.required !== false,
  );
  if (requiredGuardrails.some((guardrail) => guardrail.appliesToFiles.length === 0)) {
    return normalizePlanPaths(getPlanEditableFiles(plan), workspacePath);
  }
  return normalizePlanPaths(
    requiredGuardrails.flatMap((guardrail) => guardrail.appliesToFiles),
    workspacePath,
  );
}

export function validateOneShotPlanContract(
  plan: OneShotPlan,
  options: PlanContractValidationOptions = {},
): PlanContractValidationResult {
  const findings: PlanContractFinding[] = [];
  const implementationMode = plan.implementationMode ?? "code_change";
  const workspacePath = options.workspacePath;

  if (!plan.guardrailReport) {
    findings.push({
      code: "missing_guardrail_report",
      severity: "high",
      message:
        "Plan is missing guardrailReport; VALIDATE cannot verify required core/domain/implementer guardrails.",
    });
  } else {
    const missingCoreIds = requiredCoreGuardrailMissingIds(plan);
    if (missingCoreIds.length > 0) {
      findings.push({
        code: "missing_core_guardrail_checks",
        severity: "high",
        message: `Plan guardrailReport is missing required core guardrails: ${missingCoreIds.join(", ")}.`,
        guardrailIds: missingCoreIds,
      });
    }

    const failedCriticalOrHigh = allGuardrailChecks(plan).filter(
      (check) =>
        check.status === "failed" &&
        (check.severity === "critical" || check.severity === "high"),
    );
    if (failedCriticalOrHigh.length > 0) {
      findings.push({
        code: "guardrail_failed",
        severity: "critical",
        message:
          "Plan contains failed critical/high guardrails that must be resolved before implementation.",
        guardrailIds: failedCriticalOrHigh.map((check) => check.id),
      });
    }
  }

  if (implementationMode === "code_change") {
    const contract = plan.fileChangeContract ?? [];
    const editableFiles = normalizePlanPaths(
      getPlanEditableFiles(plan),
      workspacePath,
    );
    if (contract.length === 0) {
      findings.push({
        code: "missing_file_change_contract",
        severity: "high",
        message:
          "Code-change plan is missing fileChangeContract; implementer edit scope is not enforceable.",
      });
    } else if (editableFiles.length === 0) {
      findings.push({
        code: "missing_editable_file_contract",
        severity: "high",
        message:
          "Code-change plan has no editable runtime/test/config/source_parity files in fileChangeContract.",
      });
    }

    const contractPaths = new Set(
      contract.map((entry) => normalizePlanPath(entry.path, workspacePath)),
    );
    const uncoveredTargetFiles = getPlanImpactedFiles(plan).filter(
      (file) => !contractPaths.has(normalizePlanPath(file, workspacePath)),
    );
    if (contract.length > 0 && uncoveredTargetFiles.length > 0) {
      findings.push({
        code: "target_files_missing_from_contract",
        severity: "high",
        message:
          "Every specs[].targetFiles entry must be classified in fileChangeContract.",
        paths: uncoveredTargetFiles,
      });
    }

    if (
      (plan.plannedCodeChanges ?? []).length === 0 &&
      !plan.plannedCodeChangeRationale
    ) {
      findings.push({
        code: "missing_planned_code_changes",
        severity: "high",
        message:
          "Code-change plan lacks plannedCodeChanges and does not explain why snippets are unsafe.",
      });
    }

    if ((plan.plannedCodeChanges ?? []).length > 0) {
      const editableSet = new Set(editableFiles);
      const outOfContractSketches = (plan.plannedCodeChanges ?? [])
        .map((change) => change.targetFile)
        .filter((file) => !editableSet.has(normalizePlanPath(file, workspacePath)));
      if (outOfContractSketches.length > 0) {
        findings.push({
          code: "planned_code_change_outside_contract",
          severity: "high",
          message:
            "plannedCodeChanges target files must be editable in fileChangeContract.",
          paths: Array.from(new Set(outOfContractSketches)),
        });
      }
    }

    const testingStrategy = plan.testingStrategy;
    if (!testingStrategy) {
      findings.push({
        code: "missing_testing_strategy",
        severity: "high",
        message:
          "Code-change plan is missing testingStrategy; VALIDATE cannot verify test-first intent, planned coverage, TRACE guidance, or coverage gaps.",
      });
    } else {
      const editableTestFiles = new Set(
        normalizePlanPaths(
          contract
            .filter(
              (entry) =>
                entry.editable === true && entry.role === "test_required",
            )
            .map((entry) => entry.path),
          workspacePath,
        ),
      );
      const outOfContractTests = testingStrategy.plannedAutomatedTests
        .map((test) => test.testFile)
        .filter((file) => !editableTestFiles.has(normalizePlanPath(file, workspacePath)));
      if (outOfContractTests.length > 0) {
        findings.push({
          code: "planned_test_outside_contract",
          severity: "high",
          message:
            "testingStrategy.plannedAutomatedTests must target editable test_required files in fileChangeContract.",
          paths: Array.from(new Set(outOfContractTests)),
        });
      }

      const hasPlannedAutomatedTests =
        testingStrategy.plannedAutomatedTests.length > 0;
      const hasNoSuitableTestSurface = testingStrategy.existingTestEvidence.some(
        (evidence) => evidence.kind === "no_suitable_test_surface",
      );
      const hasManualCoverageRationale =
        testingStrategy.manualChecks.length > 0 &&
        testingStrategy.coverageGaps.length > 0 &&
        hasNoSuitableTestSurface;
      const specIds = new Set(plan.specs.map((spec) => spec.id));
      const unknownRelatedSpecIds = testingStrategy.plannedAutomatedTests.flatMap(
        (test) =>
          test.relatedSpecIds
            .filter((specId) => !specIds.has(specId))
            .map((specId) => `${test.id}:${specId}`),
      );
      if (unknownRelatedSpecIds.length > 0) {
        findings.push({
          code: "planned_test_unknown_spec",
          severity: "high",
          message:
            "testingStrategy.plannedAutomatedTests relatedSpecIds must reference existing specs[].id values.",
          paths: unknownRelatedSpecIds,
        });
      }
      const testingPassedWithoutEvidence = testingAdequacyChecks(plan).some(
        (check) =>
          (check.status === "passed" || check.status === "not_applicable") &&
          !hasPlannedAutomatedTests,
      );
      if (testingPassedWithoutEvidence) {
        findings.push({
          code: "testing_adequacy_without_evidence",
          severity: "high",
          message:
            "guardrailReport.coreChecks.testing-adequacy cannot be passed or not_applicable without planned automated tests; manual-only plans must mark testing adequacy as warning or failed with evidence-backed manual checks plus coverage gaps.",
          guardrailIds: ["testing-adequacy"],
        });
      }

      if (!hasPlannedAutomatedTests && !hasManualCoverageRationale) {
        findings.push({
          code: "missing_automated_test_or_gap",
          severity: "high",
          message:
            "Code-change plans must include at least one planned automated test or manual checks with explicit coverage gaps and no_suitable_test_surface evidence explaining why automation is not suitable.",
        });
      }
    }

    const implementerGuardrails = plan.implementerGuardrails ?? [];
    if (implementerGuardrails.length === 0) {
      findings.push({
        code: "missing_implementer_guardrails",
        severity: "high",
        message:
          "Code-change plan is missing implementerGuardrails; implementer handoff is incomplete.",
      });
    } else {
      const coveredFiles = new Set(
        editableFilesCoveredByGuardrails(plan, workspacePath),
      );
      const uncoveredEditableFiles = editableFiles.filter(
        (file) => !coveredFiles.has(file),
      );
      if (uncoveredEditableFiles.length > 0) {
        findings.push({
          code: "editable_files_missing_implementer_guardrails",
          severity: "high",
          message:
            "Every editable file must be named by at least one required implementer guardrail.",
          paths: uncoveredEditableFiles,
        });
      }
    }
  }

  const processingMode = options.processingMode ?? "standard";
  const pfosChecks = findGuardrails(
    plan,
    /(?:pfos|cve|vulnerab|security-remediation|security_remediation)/,
  );
  if (processingMode === "security_wiz" && pfosChecks.length === 0) {
    findings.push({
      code: "missing_pfos_guardrail",
      severity: "high",
      message:
        "Security remediation mode requires an explicit PFOS/CVE/package-scope guardrail decision.",
    });
  }
  if (processingMode !== "security_wiz") {
    const unsupportedPfosChecks = pfosChecks.filter(
      (check) =>
        check.status !== "not_applicable" && isLabelOnlyApplicability(check),
    );
    if (unsupportedPfosChecks.length > 0) {
      findings.push({
        code: "unsupported_pfos_applicability",
        severity: "high",
        message:
          "PFOS/security remediation applicability must be evidence-backed; a Jira label alone cannot force CVE/package scope on a standard ticket.",
        guardrailIds: unsupportedPfosChecks.map((check) => check.id),
      });
    }
  }

  const sonarChecks = findGuardrails(plan, /sonar/);
  if (processingMode === "sonar_autofix" && sonarChecks.length === 0) {
    findings.push({
      code: "missing_sonar_guardrail",
      severity: "high",
      message:
        "Sonar remediation mode requires an explicit Sonar applicability guardrail decision.",
    });
  }

  return {
    passed: findings.length === 0,
    findings,
  };
}

export function validateImplementedFilesAgainstPlanContract(
  plan: OneShotPlan,
  changedFiles: readonly string[],
  options: ImplementationFileContractOptions | string = {},
): ImplementationFileContractResult {
  const workspacePath =
    typeof options === "string" ? options : options.workspacePath;
  const contract = plan.fileChangeContract ?? [];
  const editableFiles = normalizePlanPaths(
    contract.length > 0 ? getPlanEditableFiles(plan) : getPlanImpactedFiles(plan),
    workspacePath,
  );
  const editableSet = new Set(editableFiles);
  const uniqueChangedFiles = normalizePlanPaths(changedFiles, workspacePath);
  const violatingFiles =
    contract.length === 0
      ? []
      : uniqueChangedFiles.filter((file) => !editableSet.has(file));

  return {
    passed: violatingFiles.length === 0,
    editableFiles,
    changedFiles: uniqueChangedFiles,
    violatingFiles,
  };
}

export function buildPlanContractReviewMessage(
  result: PlanContractValidationResult,
): string {
  return result.findings
    .map((finding) => {
      const details = [
        finding.message,
        finding.paths?.length ? `Files: ${finding.paths.join(", ")}` : "",
        finding.guardrailIds?.length
          ? `Guardrails: ${finding.guardrailIds.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `[${finding.severity}] ${finding.code}: ${details}`;
    })
    .join("\n");
}
