import { z } from "zod";
import type {
  OneShotPlan,
  OneShotPlanSpec,
  OneShotPlannedAutomatedTest,
} from "./plan.js";

export const TRACE_CSV_HEADER_COLUMNS = [
  "References/Key ID",
  "Req Id/Acceptance criteria ID",
  "Test Case Id",
  "Test case title",
  "Test Cases Full title",
  "Precondition",
  "Step number",
  "Step Description",
  "Expected Result",
  "Priority",
  "Fix Version",
  "Sprint #",
  "Test Case type",
  "Execution Mode",
  "Result",
  "Automation Status",
] as const;

export const TRACE_CSV_HEADER = TRACE_CSV_HEADER_COLUMNS.join(",");
export const TRACE_CSV_COLUMN_COUNT = TRACE_CSV_HEADER_COLUMNS.length;

const TraceSectionSchema = z.enum(["A", "B", "C"]);
const TraceRecommendationSchema = z.enum([
  "APPROVED",
  "CONDITIONAL",
  "REJECTED",
]);
const TraceRiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const GuardrailSeveritySchema = z.enum(["info", "warning", "high", "critical"]);
const VerifyModeSchema = z.enum(["balanced", "strict", "lenient"]);

type VerifyMode = z.infer<typeof VerifyModeSchema>;
type TraceRiskLevel = z.infer<typeof TraceRiskLevelSchema>;

interface VerifyModeThresholds {
  rejectCoverageBelow: number;
  rejectCriticalFindingsAtLeast: number;
  rejectHighFindingsAtLeast: number;
  rejectRiskLevels: TraceRiskLevel[];
  approveCoverageAtLeast: number;
  approveMaxCriticalFindings: number;
  approveMaxHighFindings: number;
  approveRiskLevels: TraceRiskLevel[];
}

export const VERIFY_MODE_THRESHOLDS: Record<VerifyMode, VerifyModeThresholds> = {
  strict: {
    rejectCoverageBelow: 95,
    rejectCriticalFindingsAtLeast: 1,
    rejectHighFindingsAtLeast: 3,
    rejectRiskLevels: ["HIGH", "CRITICAL"],
    approveCoverageAtLeast: 100,
    approveMaxCriticalFindings: 0,
    approveMaxHighFindings: 0,
    approveRiskLevels: ["LOW"],
  },
  balanced: {
    rejectCoverageBelow: 80,
    rejectCriticalFindingsAtLeast: 2,
    rejectHighFindingsAtLeast: 6,
    rejectRiskLevels: ["HIGH", "CRITICAL"],
    approveCoverageAtLeast: 95,
    approveMaxCriticalFindings: 0,
    approveMaxHighFindings: 2,
    approveRiskLevels: ["LOW"],
  },
  lenient: {
    rejectCoverageBelow: 70,
    rejectCriticalFindingsAtLeast: 1,
    rejectHighFindingsAtLeast: 8,
    rejectRiskLevels: ["CRITICAL"],
    approveCoverageAtLeast: 90,
    approveMaxCriticalFindings: 0,
    approveMaxHighFindings: 3,
    approveRiskLevels: ["LOW", "MEDIUM"],
  },
};

const VerifyModeThresholdsSchema = z.object({
  rejectCoverageBelow: z.number().min(0).max(100),
  rejectCriticalFindingsAtLeast: z.number().int().positive(),
  rejectHighFindingsAtLeast: z.number().int().positive(),
  rejectRiskLevels: z.array(TraceRiskLevelSchema),
  approveCoverageAtLeast: z.number().min(0).max(100),
  approveMaxCriticalFindings: z.number().int().nonnegative(),
  approveMaxHighFindings: z.number().int().nonnegative(),
  approveRiskLevels: z.array(TraceRiskLevelSchema),
});

export const AcceptanceCriteriaCoverageSchema = z.object({
  total: z.number().int().nonnegative(),
  covered: z.number().int().nonnegative(),
  coveragePercent: z.number().min(0).max(100),
  uncovered: z.array(z.string()),
  mapping: z.record(z.string(), z.array(z.string())),
});

export const GuardrailFindingSchema = z.object({
  id: z.string().min(1),
  severity: GuardrailSeveritySchema,
  message: z.string().min(1),
  testCaseId: z.string().min(1).optional(),
});

export const TraceGuardrailResultSchema = z.object({
  passed: z.boolean(),
  findings: z.array(GuardrailFindingSchema),
  csvValid: z.boolean(),
  columnCount: z.number().int().positive(),
});

export const TraceStepSchema = z.object({
  stepNumber: z.string().regex(/^Step [1-9]\d*$/),
  description: z.string().min(1),
  expectedResult: z.string().min(1),
});

export const TraceTestCaseSchema = z.object({
  id: z.string().min(1),
  section: TraceSectionSchema,
  requirementId: z.string().min(1),
  acceptanceCriteriaIds: z.array(z.string().min(1)).default([]),
  title: z.string().min(1),
  fullTitle: z.string().min(1),
  preconditions: z.array(z.string().min(1)).min(1),
  priority: z.enum(["Critical", "High", "Medium", "Low"]).default("High"),
  fixVersion: z.string().default(""),
  sprint: z.string().default(""),
  testCaseType: z
    .enum(["Functional", "Regression", "Unit", "Security", "Negative", "Boundary"])
    .default("Functional"),
  executionMode: z.enum(["Manual", "Automated"]).default("Manual"),
  result: z.string().default(""),
  automationStatus: z.string().default(""),
  steps: z.array(TraceStepSchema).min(1),
});

export const OneShotTraceArtifactSchema = z.object({
  jiraKey: z.string().min(1),
  planVersion: z.number().int().positive(),
  generatedAt: z.string().min(1),
  source: z.object({
    traceAgent: z.string().min(1),
    traceGuardrails: z.string().min(1).optional(),
    verifyAgent: z.string().min(1).optional(),
    verifyStandards: z.string().min(1).optional(),
    antiFabricationPolicy: z.string().min(1).optional(),
    staleSourcesRejected: z.array(z.string()).default([]),
  }),
  csvHeader: z.literal(TRACE_CSV_HEADER),
  sections: z.object({
    A: z.array(z.string()),
    B: z.array(z.string()),
    C: z.array(z.string()),
  }),
  testingStrategy: z
    .object({
      mode: z.string().min(1).optional(),
      plannedAutomatedTestIds: z.array(z.string().min(1)).default([]),
      coverageGapIds: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  acceptanceCriteriaCoverage: AcceptanceCriteriaCoverageSchema,
  traceGuardrailResult: TraceGuardrailResultSchema,
  testCases: z.array(TraceTestCaseSchema).min(1),
});

export const VerifyGapSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  message: z.string().min(1),
  affectedAcceptanceCriteria: z.array(z.string()).default([]),
  testCaseId: z.string().optional(),
});

export const OneShotVerifyReportSchema = z.object({
  jiraKey: z.string().min(1),
  planVersion: z.number().int().positive(),
  generatedAt: z.string().min(1),
  mode: VerifyModeSchema.default("balanced"),
  verifyModeThresholds: VerifyModeThresholdsSchema.optional(),
  recommendation: TraceRecommendationSchema,
  riskLevel: TraceRiskLevelSchema,
  traceTestCaseCount: z.number().int().nonnegative(),
  sectionCounts: z.object({
    A: z.number().int().nonnegative(),
    B: z.number().int().nonnegative(),
    C: z.number().int().nonnegative(),
  }),
  acceptanceCriteriaCoverage: AcceptanceCriteriaCoverageSchema,
  gaps: z.array(VerifyGapSchema),
  verifyGuardrailResult: TraceGuardrailResultSchema,
  unverifiedClaims: z.array(z.string()).default([]),
  degradedModeDisclaimers: z.array(z.string()).default([]),
});

export type TraceSection = z.infer<typeof TraceSectionSchema>;
export type TraceRecommendation = z.infer<typeof TraceRecommendationSchema>;
export type AcceptanceCriteriaCoverage = z.infer<
  typeof AcceptanceCriteriaCoverageSchema
>;
export type GuardrailFinding = z.infer<typeof GuardrailFindingSchema>;
export type TraceGuardrailResult = z.infer<typeof TraceGuardrailResultSchema>;
export type TraceStep = z.infer<typeof TraceStepSchema>;
export type TraceTestCase = z.infer<typeof TraceTestCaseSchema>;
export type OneShotTraceArtifact = z.infer<typeof OneShotTraceArtifactSchema>;
export type OneShotVerifyReport = z.infer<typeof OneShotVerifyReportSchema>;

export interface BuildTraceArtifactInput {
  jiraKey: string;
  planVersion: number;
  plan: OneShotPlan;
  ticketSummary?: string;
  fixVersion?: string;
  sprint?: string;
  generatedAt?: string;
}

export interface VerifyTraceInput {
  trace: OneShotTraceArtifact;
  csv: string;
  mode?: VerifyMode;
  generatedAt?: string;
}

interface RequirementRef {
  id: string;
  text: string;
  spec: OneShotPlanSpec;
}

const TRACE_SOURCE_SANITIZERS: ReadonlyArray<{
  pattern: RegExp;
  replacement: string;
}> = [
  {
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    replacement: "[synthetic-email]",
  },
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[synthetic-ssn]",
  },
  {
    pattern: /\b\d{3}[-.]\d{3}[-.]\d{4}\b/g,
    replacement: "[synthetic-phone]",
  },
];

function requirementId(spec: OneShotPlanSpec, index: number): string {
  return `${spec.id}-AC${index + 1}`;
}

function sanitizeTraceSourceText(value: string): string {
  return TRACE_SOURCE_SANITIZERS.reduce(
    (text, sanitizer) =>
      text.replace(sanitizer.pattern, sanitizer.replacement),
    value,
  );
}

function sanitizeTraceSourceList(
  values: readonly string[] | undefined,
): string[] {
  return (values ?? []).map(sanitizeTraceSourceText);
}

function sanitizeTracePlan(plan: OneShotPlan): OneShotPlan {
  return {
    ...plan,
    summary: sanitizeTraceSourceText(plan.summary),
    assumptions: sanitizeTraceSourceList(plan.assumptions),
    openQuestions: sanitizeTraceSourceList(plan.openQuestions),
    outOfScope: sanitizeTraceSourceList(plan.outOfScope),
    risks: sanitizeTraceSourceList(plan.risks),
    specs: plan.specs.map((spec) => ({
      ...spec,
      objective: sanitizeTraceSourceText(spec.objective),
      acceptanceCriteria: sanitizeTraceSourceList(spec.acceptanceCriteria),
      targetFiles: sanitizeTraceSourceList(spec.targetFiles),
      implementationNotes: sanitizeTraceSourceList(spec.implementationNotes),
      validationSteps: sanitizeTraceSourceList(spec.validationSteps),
      targetFileRationales: (spec.targetFileRationales ?? []).map(
        (rationale) => ({
          ...rationale,
          targetFile: sanitizeTraceSourceText(rationale.targetFile),
          rationale: sanitizeTraceSourceText(rationale.rationale),
          supportingFiles: sanitizeTraceSourceList(
            rationale.supportingFiles ?? [],
          ),
          uncertainty:
            rationale.uncertainty === undefined
              ? undefined
              : sanitizeTraceSourceText(rationale.uncertainty),
          rejectedAlternatives: sanitizeTraceSourceList(
            rationale.rejectedAlternatives ?? [],
          ),
        }),
      ),
    })),
    testingStrategy: plan.testingStrategy
      ? {
          mode: plan.testingStrategy.mode,
          existingTestEvidence:
            plan.testingStrategy.existingTestEvidence.map((evidence) => ({
              ...evidence,
              path:
                evidence.path === undefined
                  ? undefined
                  : sanitizeTraceSourceText(evidence.path),
              command:
                evidence.command === undefined
                  ? undefined
                  : sanitizeTraceSourceText(evidence.command),
              summary: sanitizeTraceSourceText(evidence.summary),
              supportingEvidence: sanitizeTraceSourceList(
                evidence.supportingEvidence,
              ),
            })),
          plannedAutomatedTests:
            plan.testingStrategy.plannedAutomatedTests.map((plannedTest) => ({
              ...plannedTest,
              testFile: sanitizeTraceSourceText(plannedTest.testFile),
              relatedSpecIds: sanitizeTraceSourceList(
                plannedTest.relatedSpecIds,
              ),
              scenario: sanitizeTraceSourceText(plannedTest.scenario),
              assertions: sanitizeTraceSourceList(plannedTest.assertions),
              command: sanitizeTraceSourceText(plannedTest.command),
              syntheticDataNotes: sanitizeTraceSourceText(
                plannedTest.syntheticDataNotes,
              ),
            })),
          validationCommands:
            plan.testingStrategy.validationCommands.map((command) => ({
              ...command,
              command: sanitizeTraceSourceText(command.command),
              expectedResult: sanitizeTraceSourceText(command.expectedResult),
              relatedSpecIds: sanitizeTraceSourceList(command.relatedSpecIds),
            })),
          manualChecks: plan.testingStrategy.manualChecks.map((check) => ({
            ...check,
            relatedSpecIds: sanitizeTraceSourceList(check.relatedSpecIds),
            scenario: sanitizeTraceSourceText(check.scenario),
            steps: sanitizeTraceSourceList(check.steps),
            expectedResult: sanitizeTraceSourceText(check.expectedResult),
            reasonNotAutomated: sanitizeTraceSourceText(
              check.reasonNotAutomated,
            ),
          })),
          traceGuidance: plan.testingStrategy.traceGuidance.map((guidance) => ({
            ...guidance,
            scenario: sanitizeTraceSourceText(guidance.scenario),
            relatedSpecIds: sanitizeTraceSourceList(guidance.relatedSpecIds),
          })),
          coverageGaps: plan.testingStrategy.coverageGaps.map((gap) => ({
            ...gap,
            relatedSpecIds: sanitizeTraceSourceList(gap.relatedSpecIds),
            gap: sanitizeTraceSourceText(gap.gap),
            reason: sanitizeTraceSourceText(gap.reason),
            risk: sanitizeTraceSourceText(gap.risk),
            followUp: sanitizeTraceSourceText(gap.followUp),
          })),
        }
      : undefined,
  };
}

function allRequirementRefs(plan: OneShotPlan): RequirementRef[] {
  return plan.specs.flatMap((spec) =>
    spec.acceptanceCriteria.map((text, index) => ({
      id: requirementId(spec, index),
      text,
      spec,
    })),
  );
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}.`;
}

function syntheticPreconditions(extra: string[] = []): string[] {
  return [
    "Use synthetic test data only; do not use real PHI, PII, credentials, or production records.",
    "Authorized test user is authenticated and has permission for the workflow under test.",
    ...extra,
  ];
}

function step(stepNumber: number, description: string, expectedResult: string): TraceStep {
  return {
    stepNumber: `Step ${stepNumber}`,
    description,
    expectedResult,
  };
}

function testcaseId(jiraKey: string, section: TraceSection, sequence: number): string {
  return `${jiraKey}-TRACE-${section}-${String(sequence).padStart(3, "0")}`;
}

function buildFunctionalCase(
  jiraKey: string,
  fixVersion: string,
  sprint: string,
  req: RequirementRef,
  sequence: number,
): TraceTestCase {
  const title = compact(`Validate ${req.spec.objective}`, 90);
  return {
    id: testcaseId(jiraKey, "A", sequence),
    section: "A",
    requirementId: req.id,
    acceptanceCriteriaIds: [req.id],
    title,
    fullTitle: compact(`${title}: ${req.text}`, 220),
    preconditions: syntheticPreconditions([
      `Target files identified by the plan are available: ${req.spec.targetFiles.join(", ")}`,
    ]),
    priority: "High",
    fixVersion,
    sprint,
    testCaseType: "Functional",
    executionMode: "Manual",
    result: "",
    automationStatus: "",
    steps: [
      step(
        1,
        `Prepare the synthetic inputs and authorized user context required for ${req.id}.`,
        "Synthetic inputs and authorization context are ready without real PHI/PII.",
      ),
      step(
        2,
        `Execute the planned workflow for acceptance criterion ${req.id}:\n- ${req.text}`,
        "The workflow completes through the planned path.",
      ),
      step(
        3,
        "Verify the UI, persisted data, integration output, or API response named by the plan.",
        "Observed behavior satisfies the acceptance criterion and preserves existing behavior.",
      ),
    ],
  };
}

function buildNegativeCase(
  jiraKey: string,
  fixVersion: string,
  sprint: string,
  spec: OneShotPlanSpec,
  sequence: number,
): TraceTestCase {
  const acIds = spec.acceptanceCriteria.map((_, index) =>
    requirementId(spec, index),
  );
  return {
    id: testcaseId(jiraKey, "A", sequence),
    section: "A",
    requirementId: acIds[0] ?? spec.id,
    acceptanceCriteriaIds: acIds,
    title: compact(`Reject invalid ${spec.objective}`, 90),
    fullTitle: compact(`Negative path coverage for ${spec.objective}`, 220),
    preconditions: syntheticPreconditions([
      `Synthetic invalid input is prepared for ${spec.objective}.`,
    ]),
    priority: "High",
    fixVersion,
    sprint,
    testCaseType: "Negative",
    executionMode: "Manual",
    result: "",
    automationStatus: "",
    steps: [
      step(
        1,
        "Prepare an invalid, unauthorized, or incomplete synthetic input for the planned workflow.",
        "Invalid input is available and no real PHI/PII is present.",
      ),
      step(
        2,
        `Attempt the workflow for ${spec.id} with the invalid input.`,
        "The system rejects the invalid path with a clear error and no partial persistence.",
      ),
      step(
        3,
        "Verify existing valid workflows continue to behave as expected after the rejection.",
        "No regression is introduced for authorized valid input.",
      ),
    ],
  };
}

function buildBoundaryCase(
  jiraKey: string,
  fixVersion: string,
  sprint: string,
  spec: OneShotPlanSpec,
  sequence: number,
): TraceTestCase {
  const acIds = spec.acceptanceCriteria.map((_, index) =>
    requirementId(spec, index),
  );
  return {
    id: testcaseId(jiraKey, "A", sequence),
    section: "A",
    requirementId: acIds[0] ?? spec.id,
    acceptanceCriteriaIds: acIds,
    title: compact(`Boundary coverage for ${spec.objective}`, 90),
    fullTitle: compact(`Boundary and edge case coverage for ${spec.objective}`, 220),
    preconditions: syntheticPreconditions([
      "Synthetic minimum, maximum, empty, and representative nominal values are available where applicable.",
    ]),
    priority: "Medium",
    fixVersion,
    sprint,
    testCaseType: "Boundary",
    executionMode: "Manual",
    result: "",
    automationStatus: "",
    steps: [
      step(
        1,
        "Execute the planned workflow with synthetic boundary values:\n- Minimum supported value\n- Maximum supported value\n- Empty or omitted optional value where applicable",
        "Boundary inputs are accepted or rejected according to the requirement.",
      ),
      step(
        2,
        `Validate the result against the acceptance criteria for ${spec.id}.`,
        "The result is deterministic, documented, and does not expose real PHI/PII.",
      ),
    ],
  };
}

function buildRegressionCase(
  jiraKey: string,
  fixVersion: string,
  sprint: string,
  spec: OneShotPlanSpec,
  sequence: number,
): TraceTestCase {
  const acIds = spec.acceptanceCriteria.map((_, index) =>
    requirementId(spec, index),
  );
  const targetFiles = spec.targetFiles.slice(0, 6).join(", ");
  return {
    id: testcaseId(jiraKey, "B", sequence),
    section: "B",
    requirementId: spec.id,
    acceptanceCriteriaIds: acIds,
    title: compact(`Regression for ${spec.objective}`, 90),
    fullTitle: compact(
      `Regression coverage for ${spec.objective} around planned targets: ${targetFiles}`,
      220,
    ),
    preconditions: syntheticPreconditions([
      `Existing behavior around ${targetFiles} is available for comparison.`,
    ]),
    priority: "Medium",
    fixVersion,
    sprint,
    testCaseType: "Regression",
    executionMode: "Manual",
    result: "",
    automationStatus: "",
    steps: [
      step(
        1,
        `Exercise existing workflows or tests that depend on ${targetFiles}.`,
        "Existing dependent behavior remains unchanged.",
      ),
      step(
        2,
        "Run or document the regression command named by the plan when available.",
        "Regression command passes or the manual verification evidence is captured.",
      ),
    ],
  };
}

function buildUnitCase(
  jiraKey: string,
  fixVersion: string,
  sprint: string,
  spec: OneShotPlanSpec,
  sequence: number,
): TraceTestCase {
  const acIds = spec.acceptanceCriteria.map((_, index) =>
    requirementId(spec, index),
  );
  return {
    id: testcaseId(jiraKey, "C", sequence),
    section: "C",
    requirementId: spec.id,
    acceptanceCriteriaIds: acIds,
    title: compact(`Unit tests for ${spec.objective}`, 90),
    fullTitle: compact(`Section C unit-test specification for ${spec.objective}`, 220),
    preconditions: [
      "Repository test framework is available in the implementation workspace.",
      "Authorized test user and permission assumptions are represented with synthetic fixtures when PHI/PII behavior is in scope.",
      `Target files: ${spec.targetFiles.join(", ")}`,
      "Use synthetic fixtures only; do not use real PHI/PII.",
    ],
    priority: "High",
    fixVersion,
    sprint,
    testCaseType: "Unit",
    executionMode: "Automated",
    result: "",
    automationStatus: "Candidate",
    steps: [
      step(
        1,
        `Add or update unit tests for ${spec.id} before changing production code.`,
        "A failing unit test captures the approved behavior before implementation.",
      ),
      step(
        2,
        `Cover acceptance criteria:\n- ${spec.acceptanceCriteria.join("\n- ")}`,
        "Unit assertions cover the acceptance criteria using synthetic fixtures.",
      ),
      step(
        3,
        `Run planned validation:\n- ${spec.validationSteps.join("\n- ")}`,
        "Relevant unit or focused validation commands pass.",
      ),
    ],
  };
}

function plannedTestAppliesToSpec(
  plannedTest: OneShotPlannedAutomatedTest,
  spec: OneShotPlanSpec,
): boolean {
  return (
    plannedTest.relatedSpecIds.length === 0 ||
    plannedTest.relatedSpecIds.includes(spec.id)
  );
}

function plannedTestType(
  plannedTest: OneShotPlannedAutomatedTest,
): TraceTestCase["testCaseType"] {
  switch (plannedTest.testType) {
    case "integration":
    case "functional":
      return "Functional";
    case "regression":
      return "Regression";
    case "security":
      return "Security";
    case "boundary":
      return "Boundary";
    case "unit":
    default:
      return "Unit";
  }
}

function buildPlannedAutomatedTestCase(
  jiraKey: string,
  fixVersion: string,
  sprint: string,
  spec: OneShotPlanSpec,
  plannedTest: OneShotPlannedAutomatedTest,
  sequence: number,
  unmatchedRelatedSpecIds: readonly string[] = [],
): TraceTestCase {
  const acIds = spec.acceptanceCriteria.map((_, index) =>
    requirementId(spec, index),
  );
  const testCaseType = plannedTestType(plannedTest);
  return {
    id: testcaseId(jiraKey, "C", sequence),
    section: "C",
    requirementId: spec.id,
    acceptanceCriteriaIds: acIds,
    title: compact(`Planned automated test ${plannedTest.id}`, 90),
    fullTitle: compact(
      `Section C ${testCaseType} handoff for ${plannedTest.id}: ${plannedTest.scenario}`,
      220,
    ),
    preconditions: syntheticPreconditions([
      `Planned test file: ${plannedTest.testFile}`,
      `Related specs: ${plannedTest.relatedSpecIds.join(", ") || spec.id}`,
      ...(unmatchedRelatedSpecIds.length > 0
        ? [`Unmatched related spec IDs: ${unmatchedRelatedSpecIds.join(", ")}`]
        : []),
      plannedTest.syntheticDataNotes,
    ]),
    priority: "High",
    fixVersion,
    sprint,
    testCaseType,
    executionMode: "Automated",
    result: "",
    automationStatus: plannedTest.failFirst ? "Fail-first planned" : "Candidate",
    steps: [
      step(
        1,
        `Create or update planned automated test ${plannedTest.id} in ${plannedTest.testFile} before runtime changes.`,
        plannedTest.failFirst
          ? "The test fails first and proves the missing behavior."
          : "The test captures the approved behavior before broad implementation work.",
      ),
      step(
        2,
        `Cover planned scenario:\n- ${plannedTest.scenario}\n\nAssertions:\n- ${plannedTest.assertions.join("\n- ")}`,
        "Assertions cover the planned behavior with synthetic data only.",
      ),
      step(
        3,
        `Run planned automated command:\n- ${plannedTest.command}`,
        "The focused automated command passes after implementation.",
      ),
    ],
  };
}

function calculateCoverage(
  requirements: RequirementRef[],
  testCases: TraceTestCase[],
): AcceptanceCriteriaCoverage {
  const mapping: Record<string, string[]> = {};
  for (const req of requirements) {
    mapping[req.id] = [];
  }

  for (const testCase of testCases) {
    for (const acId of testCase.acceptanceCriteriaIds) {
      if (!mapping[acId]) {
        mapping[acId] = [];
      }
      mapping[acId].push(testCase.id);
    }
  }

  const uncovered = requirements
    .map((req) => req.id)
    .filter((id) => (mapping[id] ?? []).length === 0);
  const covered = requirements.length - uncovered.length;
  const coveragePercent =
    requirements.length === 0
      ? 100
      : Number(((covered / requirements.length) * 100).toFixed(2));

  return {
    total: requirements.length,
    covered,
    coveragePercent,
    uncovered,
    mapping,
  };
}

export function buildOneShotTraceArtifact(
  input: BuildTraceArtifactInput,
): OneShotTraceArtifact {
  const fixVersion = input.fixVersion ?? "";
  const sprint = input.sprint ?? "";
  const tracePlan = sanitizeTracePlan(input.plan);
  const requirements = allRequirementRefs(tracePlan);
  const testCases: TraceTestCase[] = [];

  requirements.forEach((req, index) => {
    testCases.push(
      buildFunctionalCase(input.jiraKey, fixVersion, sprint, req, index + 1),
    );
  });

  let sectionASequence = requirements.length + 1;
  tracePlan.specs.forEach((spec) => {
    testCases.push(
      buildNegativeCase(
        input.jiraKey,
        fixVersion,
        sprint,
        spec,
        sectionASequence++,
      ),
    );
    testCases.push(
      buildBoundaryCase(
        input.jiraKey,
        fixVersion,
        sprint,
        spec,
        sectionASequence++,
      ),
    );
  });

  tracePlan.specs.forEach((spec, index) => {
    testCases.push(
      buildRegressionCase(input.jiraKey, fixVersion, sprint, spec, index + 1),
    );
  });

  const emittedPlannedTestIds = new Set<string>();
  tracePlan.specs.forEach((spec, index) => {
    const plannedTests = (tracePlan.testingStrategy?.plannedAutomatedTests ?? [])
      .filter((plannedTest) => {
        if (emittedPlannedTestIds.has(plannedTest.id)) {
          return false;
        }
        if (plannedTest.relatedSpecIds.length === 0) {
          return index === 0;
        }
        return plannedTestAppliesToSpec(plannedTest, spec);
      });
    if (plannedTests.length === 0) {
      testCases.push(
        buildUnitCase(input.jiraKey, fixVersion, sprint, spec, index + 1),
      );
      return;
    }
    for (const plannedTest of plannedTests) {
      testCases.push(
        buildPlannedAutomatedTestCase(
          input.jiraKey,
          fixVersion,
          sprint,
          spec,
          plannedTest,
          testCases.filter((testCase) => testCase.section === "C").length + 1,
        ),
      );
      emittedPlannedTestIds.add(plannedTest.id);
    }
  });
  const fallbackSpec = tracePlan.specs[0];
  if (fallbackSpec) {
    for (const plannedTest of tracePlan.testingStrategy?.plannedAutomatedTests ??
      []) {
      if (emittedPlannedTestIds.has(plannedTest.id)) {
        continue;
      }
      testCases.push(
        buildPlannedAutomatedTestCase(
          input.jiraKey,
          fixVersion,
          sprint,
          fallbackSpec,
          plannedTest,
          testCases.filter((testCase) => testCase.section === "C").length + 1,
          plannedTest.relatedSpecIds,
        ),
      );
      emittedPlannedTestIds.add(plannedTest.id);
    }
  }

  const coverage = calculateCoverage(requirements, testCases);
  const artifactWithoutGuardrails = {
    jiraKey: input.jiraKey,
    planVersion: input.planVersion,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: {
      traceAgent:
        "/Users/rmadhukar/Agents/cp-dev-enterprise-claude-config/agents/12-mhk-agents/agents/trace/agent.md",
      traceGuardrails:
        "/Users/rmadhukar/Agents/cp-dev-enterprise-claude-config/agents/12-mhk-agents/agents/trace/guardrails/trace-guardrails.md",
      verifyAgent:
        "/Users/rmadhukar/Agents/cp-dev-enterprise-claude-config/agents/12-mhk-agents/agents/verify/agent.md",
      verifyStandards:
        "/Users/rmadhukar/Agents/cp-dev-enterprise-claude-config/agents/12-mhk-agents/agents/verify/2.1.7.1/guardrails/verify-standards.md",
      antiFabricationPolicy:
        "/Users/rmadhukar/Agents/cp-dev-enterprise-claude-config/agents/12-mhk-agents/agents/verify/2.1.7.1/docs/ANTI_FABRICATION_POLICY.md",
      staleSourcesRejected: [
        "agentic-development-kit/4.3.2 plugin cache",
      ],
    },
    csvHeader: TRACE_CSV_HEADER,
    sections: {
      A: testCases.filter((testCase) => testCase.section === "A").map((testCase) => testCase.id),
      B: testCases.filter((testCase) => testCase.section === "B").map((testCase) => testCase.id),
      C: testCases.filter((testCase) => testCase.section === "C").map((testCase) => testCase.id),
    },
    testingStrategy: tracePlan.testingStrategy
      ? {
          mode: tracePlan.testingStrategy.mode,
          plannedAutomatedTestIds:
            tracePlan.testingStrategy.plannedAutomatedTests.map(
              (plannedTest) => plannedTest.id,
            ),
          coverageGapIds: tracePlan.testingStrategy.coverageGaps.map(
            (gap) => gap.id,
          ),
        }
      : undefined,
    acceptanceCriteriaCoverage: coverage,
    traceGuardrailResult: {
      passed: true,
      findings: [],
      csvValid: true,
      columnCount: TRACE_CSV_COLUMN_COUNT,
    },
    testCases,
  } satisfies OneShotTraceArtifact;

  const csv = renderTraceCsv(artifactWithoutGuardrails);
  const traceGuardrailResult = evaluateTraceGuardrails(
    artifactWithoutGuardrails,
    csv,
    true,
  );

  return OneShotTraceArtifactSchema.parse({
    ...artifactWithoutGuardrails,
    traceGuardrailResult,
  });
}

function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function renderCsvRow(fields: readonly string[]): string {
  if (fields.length !== TRACE_CSV_COLUMN_COUNT) {
    throw new Error(
      `TRACE CSV row has ${fields.length} columns; expected ${TRACE_CSV_COLUMN_COUNT}`,
    );
  }
  return fields.map(escapeCsvField).join(",");
}

export function renderTraceCsv(trace: OneShotTraceArtifact): string {
  const rows = [TRACE_CSV_HEADER];
  for (const testCase of trace.testCases) {
    rows.push(
      renderCsvRow([
        trace.jiraKey,
        testCase.requirementId,
        testCase.id,
        testCase.title,
        testCase.fullTitle,
        testCase.preconditions.join("\n"),
        "",
        "",
        "",
        testCase.priority,
        testCase.fixVersion,
        testCase.sprint,
        testCase.testCaseType,
        testCase.executionMode,
        testCase.result,
        testCase.automationStatus,
      ]),
    );
    for (const testStep of testCase.steps) {
      rows.push(
        renderCsvRow([
          "",
          "",
          "",
          "",
          "",
          "",
          testStep.stepNumber,
          testStep.description,
          testStep.expectedResult,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ]),
      );
    }
  }
  return `${rows.join("\r\n")}\r\n`;
}

export function parseCsvRecords(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((cell) => cell.length > 0));
}

function validateTraceCsv(csv: string): TraceGuardrailResult {
  const findings: GuardrailFinding[] = [];
  const records = parseCsvRecords(csv);
  const header = records[0]?.join(",");

  if (header !== TRACE_CSV_HEADER) {
    findings.push({
      id: "trace_csv_header",
      severity: "critical",
      message: `TRACE CSV header must be exactly "${TRACE_CSV_HEADER}".`,
    });
  }

  if (records[0]?.length !== TRACE_CSV_COLUMN_COUNT) {
    findings.push({
      id: "trace_csv_header_column_count",
      severity: "critical",
      message: `TRACE CSV header has ${records[0]?.length ?? 0} columns; expected ${TRACE_CSV_COLUMN_COUNT}.`,
    });
  }

  records.slice(1).forEach((record, index) => {
    const rowNumber = index + 2;
    if (record.length !== TRACE_CSV_COLUMN_COUNT) {
      findings.push({
        id: "trace_csv_column_count",
        severity: "critical",
        message: `TRACE CSV row ${rowNumber} has ${record.length} columns; expected ${TRACE_CSV_COLUMN_COUNT}.`,
      });
    }
    if (record.length === 8 && record[4] === "Steps") {
      findings.push({
        id: "trace_csv_legacy_eight_column_schema",
        severity: "critical",
        message: "TRACE CSV uses the stale 8-column schema; the 16-column schema is required.",
      });
    }
    if (/^section\s+[abc]$/i.test(record.join("").trim())) {
      findings.push({
        id: "trace_csv_section_separator_row",
        severity: "critical",
        message: `TRACE CSV row ${rowNumber} is a section separator row; separator rows are forbidden.`,
      });
    }
    if (record[6] && !/^Step [1-9]\d*$/.test(record[6])) {
      findings.push({
        id: "trace_csv_step_number",
        severity: "critical",
        message: `TRACE CSV row ${rowNumber} has invalid Step number "${record[6]}".`,
      });
    }
    if (/(^|\n)\s*\d+\.\s+/.test(record[7] ?? "")) {
      findings.push({
        id: "trace_csv_numbered_subactions",
        severity: "high",
        message: `TRACE CSV row ${rowNumber} embeds numbered sub-actions; use newline bullet sub-actions inside Step Description.`,
      });
    }
  });

  const staleHeader =
    records[0]?.length === 8 &&
    records[0].join(",") ===
      "Test Case ID,Category,Title,Preconditions,Steps,Expected Result,Priority,Status";
  if (staleHeader) {
    findings.push({
      id: "trace_csv_legacy_eight_column_header",
      severity: "critical",
      message: "TRACE CSV uses the forbidden legacy 8-column header.",
    });
  }

  return {
    passed: !findings.some(
      (finding) => finding.severity === "critical" || finding.severity === "high",
    ),
    findings,
    csvValid: findings.length === 0,
    columnCount: records[0]?.length ?? 0,
  };
}

function joinedTestCaseText(testCase: TraceTestCase): string {
  return [
    testCase.title,
    testCase.fullTitle,
    ...testCase.preconditions,
    ...testCase.steps.flatMap((testStep) => [
      testStep.description,
      testStep.expectedResult,
    ]),
  ].join("\n");
}

function containsRealisticPhiOrPii(text: string): boolean {
  return (
    /\b\d{3}-\d{2}-\d{4}\b/.test(text) ||
    /\b\d{3}[-.]\d{3}[-.]\d{4}\b/.test(text) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)
  );
}

function containsPhiScenario(text: string): boolean {
  return /\b(PHI|PII|patient|member|DOB|SSN|diagnosis|claim|NPI)\b/i.test(text);
}

function hasAuthPrecondition(testCase: TraceTestCase): boolean {
  return testCase.preconditions.some((precondition) =>
    /\b(auth|authorized|permission|credential|role)\b/i.test(precondition),
  );
}

function vagueTestCase(testCase: TraceTestCase): boolean {
  const text = `${testCase.title} ${testCase.fullTitle}`.toLowerCase();
  return (
    text.length < 24 ||
    /\b(verify works|test functionality|check feature|validate changes)\b/.test(text)
  );
}

export function evaluateTraceGuardrails(
  trace: OneShotTraceArtifact,
  csv: string,
  hasPlan: boolean,
): TraceGuardrailResult {
  const csvResult = validateTraceCsv(csv);
  const findings: GuardrailFinding[] = [...csvResult.findings];

  if (trace.csvHeader !== TRACE_CSV_HEADER) {
    findings.push({
      id: "trace_contract_header_constant",
      severity: "critical",
      message: "TRACE artifact csvHeader does not match the required 16-column header.",
    });
  }

  if (!hasPlan && (trace.sections.B.length > 0 || trace.sections.C.length > 0)) {
    findings.push({
      id: "trace_sections_without_plan",
      severity: "critical",
      message: "TRACE Section B/C may only be generated when a OneShot plan exists.",
    });
  }

  if (trace.acceptanceCriteriaCoverage.uncovered.length > 0) {
    findings.push({
      id: "trace_acceptance_criteria_coverage",
      severity: "critical",
      message: `TRACE leaves acceptance criteria uncovered: ${trace.acceptanceCriteriaCoverage.uncovered.join(", ")}.`,
    });
  }

  const hasNegativePath = trace.testCases.some(
    (testCase) =>
      testCase.testCaseType === "Negative" ||
      /\b(negative|reject|invalid|unauthorized|prevent)\b/i.test(
        joinedTestCaseText(testCase),
      ),
  );
  if (!hasNegativePath) {
    findings.push({
      id: "trace_negative_paths",
      severity: "high",
      message: "TRACE must include critical negative-path coverage.",
    });
  }

  for (const testCase of trace.testCases) {
    const text = joinedTestCaseText(testCase);
    if (containsRealisticPhiOrPii(text)) {
      findings.push({
        id: "trace_no_real_phi_pii",
        severity: "critical",
        testCaseId: testCase.id,
        message:
          "TRACE test case appears to include realistic PHI/PII; use synthetic data only.",
      });
    }
    if (containsPhiScenario(text) && !hasAuthPrecondition(testCase)) {
      findings.push({
        id: "trace_phi_requires_auth",
        severity: "critical",
        testCaseId: testCase.id,
        message:
          "TRACE PHI/PII scenario is missing an authentication or authorization precondition.",
      });
    }
    if (vagueTestCase(testCase)) {
      findings.push({
        id: "trace_no_vague_tests",
        severity: "high",
        testCaseId: testCase.id,
        message: "TRACE test case is too vague to execute or review.",
      });
    }
  }

  const blocking = findings.some(
    (finding) => finding.severity === "critical" || finding.severity === "high",
  );

  return {
    passed: !blocking,
    findings,
    csvValid: csvResult.csvValid,
    columnCount: csvResult.columnCount,
  };
}

function scoreRiskLevel(critical: number, high: number): z.infer<
  typeof TraceRiskLevelSchema
> {
  if (critical >= 2) return "CRITICAL";
  if (critical >= 1 || high >= 6) return "HIGH";
  if (high > 0) return "MEDIUM";
  return "LOW";
}

function recommendationFor(
  mode: VerifyMode,
  coveragePercent: number,
  critical: number,
  high: number,
  riskLevel: TraceRiskLevel,
): TraceRecommendation {
  const thresholds = VERIFY_MODE_THRESHOLDS[mode];

  if (
    coveragePercent < thresholds.rejectCoverageBelow ||
    critical >= thresholds.rejectCriticalFindingsAtLeast ||
    high >= thresholds.rejectHighFindingsAtLeast ||
    thresholds.rejectRiskLevels.includes(riskLevel)
  ) {
    return "REJECTED";
  }
  if (
    coveragePercent >= thresholds.approveCoverageAtLeast &&
    critical <= thresholds.approveMaxCriticalFindings &&
    high <= thresholds.approveMaxHighFindings &&
    thresholds.approveRiskLevels.includes(riskLevel)
  ) {
    return "APPROVED";
  }
  return "CONDITIONAL";
}

function contextsForClaim(text: string, claim: string): string[] {
  const contexts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const index = text.indexOf(claim, start);
    if (index === -1) {
      break;
    }
    contexts.push(
      text.slice(Math.max(0, index - 120), Math.min(text.length, index + claim.length + 120)),
    );
    start = index + claim.length;
  }
  return contexts;
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.replace(/\s+/g, " ").trim())),
  ).filter(Boolean);
}

function sourceSnippetsFromTraceTitles(testCase: TraceTestCase): string[] {
  const snippets: string[] = [];
  const fullTitle = testCase.fullTitle.trim();
  const title = testCase.title.trim();
  const functional = fullTitle.match(/^Validate (.+?):\s+(.+)$/);
  if (functional) {
    snippets.push(functional[1], functional[2]);
  }

  const titlePatterns = [
    /^Validate (.+)$/,
    /^Reject invalid (.+)$/,
    /^Boundary coverage for (.+)$/,
    /^Regression for (.+)$/,
    /^Unit tests for (.+)$/,
  ];
  for (const pattern of titlePatterns) {
    const match = title.match(pattern);
    if (match) {
      snippets.push(match[1]);
    }
  }

  const fullTitlePatterns = [
    /^Negative path coverage for (.+)$/,
    /^Boundary and edge case coverage for (.+)$/,
    /^Regression coverage for (.+?) around planned targets:/,
    /^Section C unit-test specification for (.+)$/,
    /^Section C \w+ handoff for (.+?):\s+(.+)$/,
  ];
  for (const pattern of fullTitlePatterns) {
    const match = fullTitle.match(pattern);
    if (match) {
      snippets.push(...match.slice(1));
    }
  }

  return uniqueNonEmpty(snippets);
}

function sourceEvidenceText(testCase: TraceTestCase): string {
  const snippets: string[] = sourceSnippetsFromTraceTitles(testCase);
  for (const testStep of testCase.steps) {
    const lines = testStep.description.split(/\r?\n/);
    if (lines.length < 2) {
      continue;
    }
    const label = lines[0];
    if (
      !/\b(acceptance criteri(?:on|a)|planned validation|planned scenario|planned automated command)\b/i.test(
        label,
      )
    ) {
      continue;
    }
    snippets.push(
      ...lines
        .slice(1)
        .map((line) => line.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean),
    );
  }
  return snippets.join("\n");
}

function generatedClaimText(testCase: TraceTestCase): string {
  return [
    ...testCase.preconditions,
    ...testCase.steps.flatMap((testStep) => [
      testStep.description,
      testStep.expectedResult,
    ]),
  ].join("\n");
}

function historicalTicketClaim(context: string): boolean {
  return /\b(prior|previous|historical|history|defect|bug|incident|regression|known issue|pattern|similar|reported|fixed|resolved|root cause|duplicate)\b/i.test(
    context,
  );
}

function sourceHasHistoricalTicketContext(
  sourceEvidence: string,
  ticket: string,
): boolean {
  return contextsForClaim(sourceEvidence, ticket).some(historicalTicketClaim);
}

type PercentageClaimKind = "measured" | "business" | "plain";

function percentageClaimKind(context: string): PercentageClaimKind {
  const measured =
    /\b(coverage|covered|quality gate|pass rate|success rate|failure rate|execution result|measured|measurement|report|tool|defect|bug|historical|trend|improv(?:e|es|ed|ement)|reduc(?:e|es|ed|tion)|increase|decrease)\b/i.test(
      context,
    );
  if (measured) {
    return "measured";
  }

  const business =
    /\b(threshold|limit|minimum|maximum|required|requirement|target|goal|at least|below|above|less than|greater than|confidence)\b/i.test(
      context,
    );
  if (business) {
    return "business";
  }

  return "plain";
}

function sourceSupportsPercentageKind(
  sourceEvidence: string,
  claim: string,
  generatedKind: PercentageClaimKind,
): boolean {
  if (generatedKind === "plain") {
    return true;
  }
  return contextsForClaim(sourceEvidence, claim).some(
    (context) => percentageClaimKind(context) === generatedKind,
  );
}

function isTraceRequirementReference(
  ticketLikeValue: string,
  testCase: TraceTestCase,
): boolean {
  return [testCase.requirementId, ...testCase.acceptanceCriteriaIds].some(
    (id) => id === ticketLikeValue || id.startsWith(`${ticketLikeValue}-`),
  );
}

function antiFabricationFindings(trace: OneShotTraceArtifact): {
  gaps: z.infer<typeof VerifyGapSchema>[];
  unverifiedClaims: string[];
  disclaimers: string[];
} {
  const gaps: z.infer<typeof VerifyGapSchema>[] = [];
  const unverifiedClaims: string[] = [];
  const disclaimers = [
    "UNABLE_TO_VERIFY: Historical Jira defect patterns were not queried; historical comparison is omitted per VERIFY anti-fabrication policy.",
    "UNABLE_TO_VERIFY: Execution results are not claimed during planning; Result cells remain blank until real execution evidence exists.",
  ];

  const otherTicketPattern = /\b[A-Z][A-Z0-9]{1,10}-\d+\b/g;
  for (const testCase of trace.testCases) {
    const text = generatedClaimText(testCase);
    const sourceEvidence = sourceEvidenceText(testCase);
    const referencedTickets = Array.from(new Set(text.match(otherTicketPattern) ?? []))
      .filter(
        (ticket) =>
          ticket !== trace.jiraKey &&
          !isTraceRequirementReference(ticket, testCase),
      );
    const unsupportedHistoricalTickets = referencedTickets.filter((ticket) => {
      const contexts = contextsForClaim(text, ticket);
      const sourceSupportsHistorical = sourceHasHistoricalTicketContext(
        sourceEvidence,
        ticket,
      );
      const historicalContexts = contexts.filter(historicalTicketClaim);
      if (sourceSupportsHistorical && historicalContexts.length > 0) {
        unverifiedClaims.push(
          `UNABLE_TO_VERIFY: ${testCase.id} references source-linked ticket ${ticket}; VERIFY did not query Jira history.`,
        );
      } else if (!sourceSupportsHistorical && contexts.length > 0) {
        unverifiedClaims.push(
          `UNABLE_TO_VERIFY: ${testCase.id} references ${ticket}; VERIFY did not query Jira linkage evidence.`,
        );
      }
      return historicalContexts.length > 0 && !sourceSupportsHistorical;
    });
    if (unsupportedHistoricalTickets.length > 0) {
      gaps.push({
        id: "verify_no_fabricated_historical_tickets",
        severity: "critical",
        message: `Test case references historical tickets without source evidence: ${unsupportedHistoricalTickets.join(", ")}.`,
        affectedAcceptanceCriteria: testCase.acceptanceCriteriaIds,
        testCaseId: testCase.id,
      });
      unverifiedClaims.push(
        `UNABLE_TO_VERIFY: ${testCase.id} references ${unsupportedHistoricalTickets.join(", ")} without source or Jira evidence.`,
      );
    }

    const percentClaims = Array.from(
      new Set(text.match(/\b\d{1,3}(?:\.\d+)?%(?!\d)/g) ?? []),
    );
    const unsupportedMeasuredPercentClaims = percentClaims.filter((claim) => {
      const contexts = contextsForClaim(text, claim);
      const measuredContexts = contexts.filter(
        (context) => percentageClaimKind(context) === "measured",
      );
      const sourceSupportsMeasured = sourceSupportsPercentageKind(
        sourceEvidence,
        claim,
        "measured",
      );
      if (sourceSupportsMeasured && measuredContexts.length > 0) {
        unverifiedClaims.push(
          `UNABLE_TO_VERIFY: ${testCase.id} includes source-derived percentage claim ${claim}; measured report evidence was not available during planning.`,
        );
      }
      return measuredContexts.length > 0 && !sourceSupportsMeasured;
    });
    if (unsupportedMeasuredPercentClaims.length > 0) {
      gaps.push({
        id: "verify_no_unmeasured_percentages",
        severity: "critical",
        message: `Test case includes measured percentage claims not produced by a report/tool: ${unsupportedMeasuredPercentClaims.join(", ")}.`,
        affectedAcceptanceCriteria: testCase.acceptanceCriteriaIds,
        testCaseId: testCase.id,
      });
      unverifiedClaims.push(
        `UNABLE_TO_VERIFY: ${testCase.id} contains unmeasured percentage claim(s): ${unsupportedMeasuredPercentClaims.join(", ")}.`,
      );
    }
  }

  return { gaps, unverifiedClaims, disclaimers };
}

function testingStrategyConsistencyGaps(
  trace: OneShotTraceArtifact,
): z.infer<typeof VerifyGapSchema>[] {
  const plannedIds = trace.testingStrategy?.plannedAutomatedTestIds ?? [];
  if (plannedIds.length === 0) {
    return [];
  }

  const sectionCText = trace.testCases
    .filter((testCase) => testCase.section === "C")
    .map(joinedTestCaseText)
    .join("\n");
  const missingIds = plannedIds.filter((id) => !sectionCText.includes(id));
  if (missingIds.length === 0) {
    return [];
  }

  return [
    {
      id: "verify_testing_strategy_planned_tests",
      severity: "critical",
      message: `VERIFY requires TRACE Section C to preserve testingStrategy planned automated test IDs: ${missingIds.join(", ")}.`,
      affectedAcceptanceCriteria: [],
    },
  ];
}

export function verifyOneShotTraceArtifact(
  input: VerifyTraceInput,
): OneShotVerifyReport {
  const mode = input.mode ?? "balanced";
  const traceGuardrails = evaluateTraceGuardrails(input.trace, input.csv, true);
  const gaps: z.infer<typeof VerifyGapSchema>[] = traceGuardrails.findings.map(
    (finding) => ({
      id: finding.id,
      severity:
        finding.severity === "critical"
          ? "critical"
          : finding.severity === "high"
            ? "high"
            : finding.severity === "warning"
              ? "medium"
              : "low",
      message: finding.message,
      affectedAcceptanceCriteria: finding.testCaseId
        ? (input.trace.testCases.find((testCase) => testCase.id === finding.testCaseId)
            ?.acceptanceCriteriaIds ?? [])
        : [],
      testCaseId: finding.testCaseId,
    }),
  );

  const hasBoundaryCoverage = input.trace.testCases.some(
    (testCase) =>
      testCase.testCaseType === "Boundary" ||
      /\b(boundary|min|max|empty|edge)\b/i.test(joinedTestCaseText(testCase)),
  );
  if (!hasBoundaryCoverage) {
    gaps.push({
      id: "verify_boundary_coverage",
      severity: "high",
      message: "VERIFY requires boundary or edge-case coverage when applicable.",
      affectedAcceptanceCriteria: [],
    });
  }

  const hasSectionC = input.trace.sections.C.length > 0;
  if (!hasSectionC) {
    gaps.push({
      id: "verify_section_c_unit_specs",
      severity: "high",
      message: "VERIFY requires Section C unit-test specifications for Build handoff.",
      affectedAcceptanceCriteria: [],
    });
  }

  const antiFabrication = antiFabricationFindings(input.trace);
  gaps.push(...antiFabrication.gaps);
  gaps.push(...testingStrategyConsistencyGaps(input.trace));

  const critical = gaps.filter((gap) => gap.severity === "critical").length;
  const high = gaps.filter((gap) => gap.severity === "high").length;
  const riskLevel = scoreRiskLevel(critical, high);
  const recommendation = recommendationFor(
    mode,
    input.trace.acceptanceCriteriaCoverage.coveragePercent,
    critical,
    high,
    riskLevel,
  );

  const report = {
    jiraKey: input.trace.jiraKey,
    planVersion: input.trace.planVersion,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode,
    verifyModeThresholds: VERIFY_MODE_THRESHOLDS[mode],
    recommendation,
    riskLevel,
    traceTestCaseCount: input.trace.testCases.length,
    sectionCounts: {
      A: input.trace.sections.A.length,
      B: input.trace.sections.B.length,
      C: input.trace.sections.C.length,
    },
    acceptanceCriteriaCoverage: input.trace.acceptanceCriteriaCoverage,
    gaps,
    verifyGuardrailResult: {
      ...traceGuardrails,
      passed: recommendation !== "REJECTED",
      findings: gaps.map((gap) => ({
        id: gap.id,
        severity:
          gap.severity === "critical"
            ? "critical"
            : gap.severity === "high"
              ? "high"
              : gap.severity === "medium"
                ? "warning"
                : "info",
        message: gap.message,
        testCaseId: gap.testCaseId,
      })),
    },
    unverifiedClaims: antiFabrication.unverifiedClaims,
    degradedModeDisclaimers: antiFabrication.disclaimers,
  } satisfies OneShotVerifyReport;

  return OneShotVerifyReportSchema.parse(report);
}

export function sectionCTestCases(trace: OneShotTraceArtifact): TraceTestCase[] {
  return trace.testCases.filter((testCase) => testCase.section === "C");
}

export function buildTraceJiraComment(input: {
  trace: OneShotTraceArtifact;
  verify?: OneShotVerifyReport;
  csvS3Key: string;
  filename: string;
  attachmentStatus: "attached" | "skipped" | "failed";
  attachmentError?: string;
}): string {
  const { trace, verify } = input;
  const lines = [
    "# OneShot | TRACE Test Cases Generated",
    "",
    `TRACE generated \`${input.filename}\` for ${trace.jiraKey}.`,
    "",
    `- Section A: ${trace.sections.A.length}`,
    `- Section B: ${trace.sections.B.length}`,
    `- Section C: ${trace.sections.C.length}`,
    `- Acceptance criteria coverage: ${trace.acceptanceCriteriaCoverage.covered}/${trace.acceptanceCriteriaCoverage.total} (${trace.acceptanceCriteriaCoverage.coveragePercent}%)`,
    `- CSV artifact: \`${input.csvS3Key}\``,
    `- Jira attachment: ${input.attachmentStatus}`,
  ];
  if (input.attachmentError) {
    lines.push(`- Attachment issue: ${input.attachmentError}`);
  }
  if (verify) {
    lines.push(
      `- VERIFY recommendation: ${verify.recommendation}`,
      `- VERIFY risk: ${verify.riskLevel}`,
    );
  }
  if (trace.acceptanceCriteriaCoverage.uncovered.length > 0) {
    lines.push(
      `- Uncovered acceptance criteria: ${trace.acceptanceCriteriaCoverage.uncovered.join(", ")}`,
    );
  }
  return lines.join("\n");
}

export function parseOneShotTraceArtifact(value: unknown): OneShotTraceArtifact {
  return OneShotTraceArtifactSchema.parse(value);
}

export function parseOneShotVerifyReport(value: unknown): OneShotVerifyReport {
  return OneShotVerifyReportSchema.parse(value);
}
