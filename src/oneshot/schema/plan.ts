import { z } from "zod";
import {
  normalizeRetrofitEvidenceOptionalFields,
  normalizeRetrofitExecutionContractOptionalFields,
  RetrofitExecutionContractV1Schema,
} from "../retrofit-execution-contract.js";

export const OneShotImplementationModeSchema = z
  .enum(["code_change", "verification_only"])
  .default("code_change");

export const CORE_GUARDRAIL_IDS = [
  "generated-cache-exclusion",
  "security-secrets",
  "phi-pii",
  "backward-compatibility",
  "performance-n-plus-one",
  "error-handling",
  "testing-adequacy",
  "scope-discipline",
] as const;

export const OneShotFileChangeRoleSchema = z.enum([
  "runtime_required",
  "test_required",
  "config_required",
  "source_parity",
  "read_only_evidence",
  "forbidden",
]);

export const OneShotFileChangeContractEntrySchema = z.object({
  path: z.string().min(1).max(500),
  role: OneShotFileChangeRoleSchema,
  editable: z.boolean(),
  rationale: z.string().min(1).max(3000),
  supportingEvidence: z.array(z.string().min(1).max(1000)).default([]),
  allowedChanges: z.array(z.string().min(1).max(1000)).default([]),
});

export const OneShotPlannedCodeChangeSchema = z.object({
  targetFile: z.string().min(1).max(500),
  symbolOrRegion: z.string().min(1).max(500),
  changeType: z.enum(["insert", "update", "delete", "replace", "create"]),
  beforeSnippet: z.string().max(6000).optional(),
  afterSketch: z.string().min(1).max(10000),
  rationale: z.string().min(1).max(3000),
  supportingEvidence: z.array(z.string().min(1).max(1000)).min(1).max(12),
  confidence: z.enum(["low", "medium", "high"]),
});

export const OneShotGuardrailCheckSchema = z.object({
  id: z.string().min(1).max(120),
  severity: z.enum(["critical", "high", "medium", "low"]),
  status: z.enum(["passed", "warning", "failed", "not_applicable"]),
  applicabilityReason: z.string().min(1).max(3000),
  evidence: z.array(z.string().min(1).max(1000)).default([]),
  requiredAction: z.string().min(1).max(3000),
});

export const OneShotGuardrailReportSchema = z.object({
  coreChecks: z.array(OneShotGuardrailCheckSchema).default([]),
  domainChecks: z.array(OneShotGuardrailCheckSchema).default([]),
  implementerChecks: z.array(OneShotGuardrailCheckSchema).default([]),
});

export const OneShotImplementerGuardrailSchema = z.object({
  id: z.string().min(1).max(120),
  instruction: z.string().min(1).max(3000),
  appliesToFiles: z.array(z.string().min(1).max(500)).default([]),
  required: z.boolean().default(true),
});

export const OneShotTestingStrategyModeSchema = z.enum([
  "test_first",
  "focused_regression",
  "manual_verification",
  "verification_only",
]);

export const OneShotExistingTestEvidenceSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(["test_file", "fixture", "command", "no_suitable_test_surface"]),
  path: z.string().min(1).max(500).optional(),
  command: z.string().min(1).max(1000).optional(),
  summary: z.string().min(1).max(3000),
  supportingEvidence: z.array(z.string().min(1).max(1000)).default([]),
});

export const OneShotPlannedAutomatedTestSchema = z.object({
  id: z.string().min(1).max(120),
  testFile: z.string().min(1).max(500),
  relatedSpecIds: z.array(z.string().min(1).max(120)).default([]),
  testType: z.enum([
    "unit",
    "integration",
    "functional",
    "regression",
    "security",
    "boundary",
  ]),
  scenario: z.string().min(1).max(3000),
  assertions: z.array(z.string().min(1).max(1000)).min(1).max(20),
  failFirst: z.boolean(),
  command: z.string().min(1).max(1000),
  syntheticDataNotes: z.string().min(1).max(3000),
});

export const OneShotTestingValidationCommandSchema = z.object({
  command: z.string().min(1).max(1000),
  expectedResult: z.string().min(1).max(3000),
  scope: z.enum(["focused", "module", "full", "manual"]),
  relatedSpecIds: z.array(z.string().min(1).max(120)).default([]),
});

export const OneShotManualCheckSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  relatedSpecIds: z.array(z.string().min(1).max(120)).default([]),
  scenario: z.string().min(1).max(3000),
  steps: z.array(z.string().min(1).max(1000)).min(1).max(20),
  expectedResult: z.string().min(1).max(3000),
  reasonNotAutomated: z.string().min(1).max(3000),
});

export const OneShotTraceGuidanceSchema = z.object({
  id: z.string().min(1).max(120),
  section: z.enum(["A", "B", "C"]),
  testType: z.enum([
    "Functional",
    "Regression",
    "Unit",
    "Security",
    "Negative",
    "Boundary",
  ]),
  scenario: z.string().min(1).max(3000),
  relatedSpecIds: z.array(z.string().min(1).max(120)).default([]),
  priority: z.enum(["Critical", "High", "Medium", "Low"]),
});

export const OneShotCoverageGapSchema = z.object({
  id: z.string().min(1).max(120),
  relatedSpecIds: z.array(z.string().min(1).max(120)).default([]),
  gap: z.string().min(1).max(3000),
  reason: z.string().min(1).max(3000),
  risk: z.string().min(1).max(3000),
  followUp: z.string().min(1).max(3000),
});

export const OneShotTestingStrategySchema = z.object({
  mode: OneShotTestingStrategyModeSchema,
  existingTestEvidence: z.array(OneShotExistingTestEvidenceSchema).default([]),
  plannedAutomatedTests: z.array(OneShotPlannedAutomatedTestSchema).default([]),
  validationCommands: z.array(OneShotTestingValidationCommandSchema).default([]),
  manualChecks: z.array(OneShotManualCheckSchema).default([]),
  traceGuidance: z.array(OneShotTraceGuidanceSchema).default([]),
  coverageGaps: z.array(OneShotCoverageGapSchema).default([]),
});

export const OneShotTargetFileRationaleSchema = z.object({
  targetFile: z.string().min(1),
  rationale: z.string().min(1),
  supportingFiles: z.array(z.string().min(1)).default([]),
  uncertainty: z.string().min(1).optional(),
  rejectedAlternatives: z.array(z.string().min(1)).default([]),
});

export const OneShotPlanSpecSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  targetFiles: z.array(z.string().min(1)).min(1),
  targetFileRationales: z.array(OneShotTargetFileRationaleSchema).default([]),
  implementationNotes: z.array(z.string().min(1)).min(1),
  validationSteps: z.array(z.string().min(1)).min(1),
});

export const OneShotRetrofitEvidenceSchema = z.object({
  sourceJiraKey: z.string().min(1).max(80),
  sourceBranch: z.string().min(1).max(200),
  targetBranch: z.string().min(1).max(200),
  sourcePrUrl: z.string().url().optional(),
  commitSelectionMethod: z
    .enum([
      "source_pr",
      "source_run_pr",
      "jira_pr_link",
      "github_pr_search",
      "commit_pr_expansion",
      "subject_grep_only",
    ])
    .default("subject_grep_only"),
  sourceCommitSelectionComplete: z.boolean().default(false),
  selectedCommits: z
    .array(
      z.object({
        sha: z.string().min(7).max(40),
        subject: z.string().min(1).max(300),
        files: z.array(z.string().min(1).max(300)).max(30).default([]),
        alreadyApplied: z.boolean().default(false),
      }),
    )
    .max(20)
    .default([]),
  touchedFiles: z.array(z.string().min(1).max(300)).max(50).default([]),
  alreadyApplied: z.boolean().default(false),
  evidenceSummary: z.string().min(1).max(2000),
});

export const OneShotPlannerDiscoveriesSchema = z.object({
  buildCommand: z.string().max(500).optional(),
  testCommand: z.string().max(500).optional(),
  testPattern: z.string().max(500).optional(),
  entryPoints: z.array(z.string().max(500)).max(10).default([]),
  relevantPatterns: z.array(z.string().max(1000)).max(10).default([]),
  keyDependencies: z.array(z.string().max(200)).max(15).default([]),
  retrofitEvidence: OneShotRetrofitEvidenceSchema.optional(),
  retrofitExecutionContract: RetrofitExecutionContractV1Schema.optional(),
});

const OneShotRetrofitAlreadyAppliedOutputSchema = z.object({
  plannerDiscoveries: z.object({
    retrofitEvidence: OneShotRetrofitEvidenceSchema.extend({
      alreadyApplied: z.literal(true),
    }),
  }),
});

export const OneShotPlanSchema = z.object({
  jiraKey: z.string().min(1),
  repoName: z.string().min(1),
  branchName: z.string().min(1),
  baseCommitSha: z.string().min(7).max(40),
  summary: z.string().min(1),
  implementationMode: OneShotImplementationModeSchema,
  specs: z.array(OneShotPlanSpecSchema).min(1),
  assumptions: z.array(z.string().min(1)).default([]),
  openQuestions: z.array(z.string().min(1)).default([]),
  outOfScope: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  plannerDiscoveries: OneShotPlannerDiscoveriesSchema.optional(),
  fileChangeContract: z
    .array(OneShotFileChangeContractEntrySchema)
    .default([]),
  plannedCodeChanges: z.array(OneShotPlannedCodeChangeSchema).default([]),
  plannedCodeChangeRationale: z.string().min(1).max(3000).optional(),
  guardrailReport: OneShotGuardrailReportSchema.optional(),
  testingStrategy: OneShotTestingStrategySchema.optional(),
  implementerGuardrails: z.array(OneShotImplementerGuardrailSchema).default([]),
});

export type OneShotPlanSpec = z.infer<typeof OneShotPlanSpecSchema>;
export type OneShotFileChangeRole = z.infer<
  typeof OneShotFileChangeRoleSchema
>;
export type OneShotFileChangeContractEntry = z.infer<
  typeof OneShotFileChangeContractEntrySchema
>;
export type OneShotPlannedCodeChange = z.infer<
  typeof OneShotPlannedCodeChangeSchema
>;
export type OneShotGuardrailCheck = z.infer<typeof OneShotGuardrailCheckSchema>;
export type OneShotGuardrailReport = z.infer<
  typeof OneShotGuardrailReportSchema
>;
export type OneShotImplementerGuardrail = z.infer<
  typeof OneShotImplementerGuardrailSchema
>;
export type OneShotTestingStrategy = z.infer<
  typeof OneShotTestingStrategySchema
>;
export type OneShotPlannedAutomatedTest = z.infer<
  typeof OneShotPlannedAutomatedTestSchema
>;
export type OneShotTargetFileRationale = z.infer<
  typeof OneShotTargetFileRationaleSchema
>;
export type OneShotPlannerDiscoveries = z.infer<
  typeof OneShotPlannerDiscoveriesSchema
>;
export type OneShotImplementationMode = z.infer<
  typeof OneShotImplementationModeSchema
>;
export type OneShotRetrofitEvidence = z.infer<
  typeof OneShotRetrofitEvidenceSchema
>;
type ParsedOneShotPlan = z.infer<typeof OneShotPlanSchema>;
export type OneShotPlan = Omit<
  ParsedOneShotPlan,
  | "implementationMode"
  | "fileChangeContract"
  | "plannedCodeChanges"
  | "plannedCodeChangeRationale"
  | "guardrailReport"
  | "testingStrategy"
  | "implementerGuardrails"
> & {
  implementationMode?: OneShotImplementationMode;
  fileChangeContract?: OneShotFileChangeContractEntry[];
  plannedCodeChanges?: OneShotPlannedCodeChange[];
  plannedCodeChangeRationale?: string;
  guardrailReport?: OneShotGuardrailReport;
  testingStrategy?: OneShotTestingStrategy;
  implementerGuardrails?: OneShotImplementerGuardrail[];
};

const LEGACY_IMPLEMENTATION_MODE_DEFAULTED = Symbol(
  "oneshot.legacyImplementationModeDefaulted",
);
type OneShotPlanWithParserMetadata = OneShotPlan & {
  [LEGACY_IMPLEMENTATION_MODE_DEFAULTED]?: true;
};

export interface PlannerDiscoverySanitizationReport {
  truncatedFields: Array<{
    path: string;
    originalLength: number;
    cap: number;
  }>;
  droppedArrayEntries: number;
  droppedEmptyValues: number;
  normalizedOptionalFields: string[];
}

export interface PlannerStructuredOutputRepairReport {
  repaired: boolean;
  trimmedStrings: number;
  droppedEmptyArrayEntries: number;
  promotedTargetFiles: number;
  droppedSpecs: number;
}

function emptyRepairReport(): PlannerStructuredOutputRepairReport {
  return {
    repaired: false,
    trimmedStrings: 0,
    droppedEmptyArrayEntries: 0,
    promotedTargetFiles: 0,
    droppedSpecs: 0,
  };
}

function markRepaired(report: PlannerStructuredOutputRepairReport): void {
  report.repaired = true;
}

function trimStructuredValue(
  value: unknown,
  report: PlannerStructuredOutputRepairReport,
): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== value) {
      report.trimmedStrings += 1;
      markRepaired(report);
    }
    return trimmed;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => trimStructuredValue(entry, report));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      trimStructuredValue(entry, report),
    ]),
  );
}

function compactStringArray(
  value: unknown,
  report: PlannerStructuredOutputRepairReport,
): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  const compacted = value.filter((entry) => {
    if (typeof entry !== "string") {
      return true;
    }
    if (entry.length > 0) {
      return true;
    }
    report.droppedEmptyArrayEntries += 1;
    markRepaired(report);
    return false;
  });

  return compacted;
}

function compactPlanStringArrays(
  plan: Record<string, unknown>,
  report: PlannerStructuredOutputRepairReport,
): void {
  for (const key of [
    "assumptions",
    "openQuestions",
    "outOfScope",
    "risks",
  ] as const) {
    plan[key] = compactStringArray(plan[key], report);
  }
}

function compactSpecStringArrays(
  spec: Record<string, unknown>,
  report: PlannerStructuredOutputRepairReport,
): void {
  for (const key of [
    "acceptanceCriteria",
    "targetFiles",
    "implementationNotes",
    "validationSteps",
  ] as const) {
    spec[key] = compactStringArray(spec[key], report);
  }
}

function compactTargetFileRationales(
  spec: Record<string, unknown>,
  report: PlannerStructuredOutputRepairReport,
): void {
  if (!Array.isArray(spec.targetFileRationales)) {
    return;
  }

  spec.targetFileRationales = spec.targetFileRationales
    .filter(
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
    )
    .map((entry) => {
      const rationale = entry as Record<string, unknown>;
      return {
        ...rationale,
        supportingFiles: compactStringArray(rationale.supportingFiles, report),
        rejectedAlternatives: compactStringArray(
          rationale.rejectedAlternatives,
          report,
        ),
      };
    });
}

function promoteTargetFilesFromRationales(
  spec: Record<string, unknown>,
  report: PlannerStructuredOutputRepairReport,
): void {
  const targetFiles = Array.isArray(spec.targetFiles) ? spec.targetFiles : [];
  if (
    targetFiles.some((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    return;
  }

  const promoted = Array.isArray(spec.targetFileRationales)
    ? spec.targetFileRationales
        .map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>).targetFile
            : undefined,
        )
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.length > 0,
        )
    : [];

  if (promoted.length === 0) {
    return;
  }

  spec.targetFiles = Array.from(new Set(promoted));
  report.promotedTargetFiles += promoted.length;
  markRepaired(report);
}

function repairPlanSpec(
  spec: unknown,
  report: PlannerStructuredOutputRepairReport,
): unknown | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return null;
  }

  const repaired = { ...(spec as Record<string, unknown>) };
  compactSpecStringArrays(repaired, report);
  compactTargetFileRationales(repaired, report);
  promoteTargetFilesFromRationales(repaired, report);

  if (OneShotPlanSpecSchema.safeParse(repaired).success) {
    return repaired;
  }

  return null;
}

export function repairOneShotStructuredPlanOutput(raw: unknown): {
  value: unknown;
  report: PlannerStructuredOutputRepairReport;
} {
  const report = emptyRepairReport();
  const trimmed = trimStructuredValue(raw, report);
  if (!trimmed || typeof trimmed !== "object" || Array.isArray(trimmed)) {
    return { value: trimmed, report };
  }

  const plan = { ...(trimmed as Record<string, unknown>) };
  compactPlanStringArrays(plan, report);

  if (Array.isArray(plan.specs)) {
    const originalSpecs = plan.specs;
    const repairedSpecs = originalSpecs
      .map((spec) => repairPlanSpec(spec, report))
      .filter((spec): spec is Exclude<typeof spec, null> => spec !== null);

    if (
      repairedSpecs.length > 0 &&
      repairedSpecs.length < originalSpecs.length
    ) {
      report.droppedSpecs += originalSpecs.length - repairedSpecs.length;
      markRepaired(report);
      plan.specs = repairedSpecs;
    } else if (repairedSpecs.length === originalSpecs.length) {
      plan.specs = repairedSpecs;
    }
  }

  return { value: plan, report };
}

const PLANNER_DISCOVERY_LIMITS = {
  buildCommand: 500,
  testCommand: 500,
  testPattern: 500,
  entryPoints: { maxItems: 10, maxLength: 500 },
  relevantPatterns: { maxItems: 10, maxLength: 1000 },
  keyDependencies: { maxItems: 15, maxLength: 200 },
  retrofitTouchedFiles: { maxItems: 50, maxLength: 300 },
  retrofitCommitFiles: { maxItems: 30, maxLength: 300 },
  retrofitEvidenceSummary: 2000,
} as const;

function emptySanitizationReport(): PlannerDiscoverySanitizationReport {
  return {
    truncatedFields: [],
    droppedArrayEntries: 0,
    droppedEmptyValues: 0,
    normalizedOptionalFields: [],
  };
}

function truncateDiscoveryString(
  value: string,
  path: string,
  cap: number,
  report: PlannerDiscoverySanitizationReport,
): string {
  const trimmed = value.trim();
  if (trimmed.length <= cap) {
    return trimmed;
  }
  report.truncatedFields.push({
    path,
    originalLength: trimmed.length,
    cap,
  });
  return `${trimmed.slice(0, Math.max(0, cap - 3)).trimEnd()}...`;
}

function sanitizeDiscoveryArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxLength: number,
  report: PlannerDiscoverySanitizationReport,
): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  if (value.length > maxItems) {
    report.droppedArrayEntries += value.length - maxItems;
  }

  return value
    .slice(0, maxItems)
    .filter((entry) => {
      if (typeof entry !== "string") {
        return true;
      }
      if (entry.trim().length > 0) {
        return true;
      }
      report.droppedEmptyValues += 1;
      return false;
    })
    .map((entry, index) => {
      if (typeof entry !== "string") {
        return entry;
      }
      return truncateDiscoveryString(
        entry,
        `${path}[${index}]`,
        maxLength,
        report,
      );
    });
}

export function sanitizePlannerDiscoveries(raw: unknown): {
  value: unknown;
  report: PlannerDiscoverySanitizationReport;
} {
  const report = emptySanitizationReport();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: raw, report };
  }

  const plan = raw as Record<string, unknown>;
  const rawDiscoveries = plan.plannerDiscoveries;
  if (
    !rawDiscoveries ||
    typeof rawDiscoveries !== "object" ||
    Array.isArray(rawDiscoveries)
  ) {
    return { value: raw, report };
  }

  const discoveries = { ...(rawDiscoveries as Record<string, unknown>) };
  for (const key of ["buildCommand", "testCommand", "testPattern"] as const) {
    const value = discoveries[key];
    if (typeof value !== "string") {
      continue;
    }
    if (value.trim().length === 0) {
      delete discoveries[key];
      report.droppedEmptyValues += 1;
      continue;
    }
    discoveries[key] = truncateDiscoveryString(
      value,
      `plannerDiscoveries.${key}`,
      PLANNER_DISCOVERY_LIMITS[key],
      report,
    );
  }

  for (const key of [
    "entryPoints",
    "relevantPatterns",
    "keyDependencies",
  ] as const) {
    const limits = PLANNER_DISCOVERY_LIMITS[key];
    discoveries[key] = sanitizeDiscoveryArray(
      discoveries[key],
      `plannerDiscoveries.${key}`,
      limits.maxItems,
      limits.maxLength,
      report,
    );
  }

  const retrofitEvidence = discoveries.retrofitEvidence;
  if (
    retrofitEvidence &&
    typeof retrofitEvidence === "object" &&
    !Array.isArray(retrofitEvidence)
  ) {
    const evidence = {
      ...(retrofitEvidence as Record<string, unknown>),
    };
    if (typeof evidence.evidenceSummary === "string") {
      evidence.evidenceSummary = truncateDiscoveryString(
        evidence.evidenceSummary,
        "plannerDiscoveries.retrofitEvidence.evidenceSummary",
        PLANNER_DISCOVERY_LIMITS.retrofitEvidenceSummary,
        report,
      );
    }
    evidence.touchedFiles = sanitizeDiscoveryArray(
      evidence.touchedFiles,
      "plannerDiscoveries.retrofitEvidence.touchedFiles",
      PLANNER_DISCOVERY_LIMITS.retrofitTouchedFiles.maxItems,
      PLANNER_DISCOVERY_LIMITS.retrofitTouchedFiles.maxLength,
      report,
    );
    if (Array.isArray(evidence.selectedCommits)) {
      evidence.selectedCommits = evidence.selectedCommits
        .slice(0, 20)
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return entry;
          }
          const commit = { ...(entry as Record<string, unknown>) };
          commit.files = sanitizeDiscoveryArray(
            commit.files,
            "plannerDiscoveries.retrofitEvidence.selectedCommits.files",
            PLANNER_DISCOVERY_LIMITS.retrofitCommitFiles.maxItems,
            PLANNER_DISCOVERY_LIMITS.retrofitCommitFiles.maxLength,
            report,
          );
          return commit;
        });
    }
    const normalized = normalizeRetrofitEvidenceOptionalFields(evidence);
    report.normalizedOptionalFields.push(
      ...normalized.report.normalizedOptionalFields,
    );
    discoveries.retrofitEvidence = normalized.value;
  }

  const retrofitExecutionContract = discoveries.retrofitExecutionContract;
  if (
    retrofitExecutionContract &&
    typeof retrofitExecutionContract === "object" &&
    !Array.isArray(retrofitExecutionContract)
  ) {
    const normalized =
      normalizeRetrofitExecutionContractOptionalFields(
        retrofitExecutionContract,
      );
    report.normalizedOptionalFields.push(
      ...normalized.report.normalizedOptionalFields,
    );
    discoveries.retrofitExecutionContract = normalized.value;
  }

  return {
    value: {
      ...plan,
      plannerDiscoveries: discoveries,
    },
    report,
  };
}

export function plannerDiscoveriesWereSanitized(
  report: PlannerDiscoverySanitizationReport,
): boolean {
  return (
    report.truncatedFields.length > 0 ||
    report.droppedArrayEntries > 0 ||
    report.droppedEmptyValues > 0 ||
    report.normalizedOptionalFields.length > 0
  );
}

export function mergePlannerDiscoverySanitizationReports(
  ...reports: PlannerDiscoverySanitizationReport[]
): PlannerDiscoverySanitizationReport {
  return reports.reduce<PlannerDiscoverySanitizationReport>(
    (merged, report) => ({
      truncatedFields: [...merged.truncatedFields, ...report.truncatedFields],
      droppedArrayEntries:
        merged.droppedArrayEntries + report.droppedArrayEntries,
      droppedEmptyValues: merged.droppedEmptyValues + report.droppedEmptyValues,
      normalizedOptionalFields: [
        ...merged.normalizedOptionalFields,
        ...report.normalizedOptionalFields,
      ],
    }),
    emptySanitizationReport(),
  );
}

export function plannerDiscoverySanitizationTruncatedChars(
  report: PlannerDiscoverySanitizationReport,
): number {
  return report.truncatedFields.reduce(
    (sum, field) => sum + Math.max(0, field.originalLength - field.cap),
    0,
  );
}

export const ONE_SHOT_PLAN_OUTPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    jiraKey: { type: "string" as const, minLength: 1 },
    repoName: { type: "string" as const, minLength: 1 },
    branchName: { type: "string" as const, minLength: 1 },
    baseCommitSha: { type: "string" as const, minLength: 7, maxLength: 40 },
    summary: { type: "string" as const, minLength: 1, maxLength: 4000 },
    implementationMode: {
      type: "string" as const,
      enum: ["code_change", "verification_only"],
    },
    specs: {
      type: "array" as const,
      minItems: 1,
      maxItems: 15,
      items: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          id: { type: "string" as const, minLength: 1 },
          objective: { type: "string" as const, minLength: 1, maxLength: 3000 },
          acceptanceCriteria: {
            type: "array" as const,
            minItems: 1,
            maxItems: 10,
            items: { type: "string" as const, minLength: 1, maxLength: 2000 },
          },
          targetFiles: {
            type: "array" as const,
            minItems: 1,
            maxItems: 25,
            items: { type: "string" as const, minLength: 1, maxLength: 300 },
          },
          targetFileRationales: {
            type: "array" as const,
            maxItems: 25,
            items: {
              type: "object" as const,
              additionalProperties: false,
              properties: {
                targetFile: { type: "string" as const, minLength: 1 },
                rationale: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 3000,
                },
                supportingFiles: {
                  type: "array" as const,
                  items: {
                    type: "string" as const,
                    minLength: 1,
                    maxLength: 300,
                  },
                },
                uncertainty: { type: "string" as const, minLength: 1 },
                rejectedAlternatives: {
                  type: "array" as const,
                  items: { type: "string" as const, minLength: 1 },
                },
              },
              required: ["targetFile", "rationale"],
            },
          },
          implementationNotes: {
            type: "array" as const,
            minItems: 1,
            maxItems: 12,
            items: { type: "string" as const, minLength: 1, maxLength: 3000 },
          },
          validationSteps: {
            type: "array" as const,
            minItems: 1,
            maxItems: 10,
            items: { type: "string" as const, minLength: 1, maxLength: 2000 },
          },
        },
        required: [
          "id",
          "objective",
          "acceptanceCriteria",
          "targetFiles",
          "implementationNotes",
          "validationSteps",
        ],
      },
    },
    assumptions: {
      type: "array" as const,
      maxItems: 12,
      items: { type: "string" as const, minLength: 1, maxLength: 2000 },
    },
    openQuestions: {
      type: "array" as const,
      maxItems: 12,
      items: { type: "string" as const, minLength: 1, maxLength: 2000 },
    },
    outOfScope: {
      type: "array" as const,
      maxItems: 12,
      items: { type: "string" as const, minLength: 1, maxLength: 2000 },
    },
    risks: {
      type: "array" as const,
      maxItems: 12,
      items: { type: "string" as const, minLength: 1, maxLength: 2000 },
    },
    plannerDiscoveries: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        buildCommand: { type: "string" as const, maxLength: 500 },
        testCommand: { type: "string" as const, maxLength: 500 },
        testPattern: { type: "string" as const, maxLength: 500 },
        entryPoints: {
          type: "array" as const,
          maxItems: 10,
          items: { type: "string" as const, maxLength: 500 },
        },
        relevantPatterns: {
          type: "array" as const,
          maxItems: 10,
          items: { type: "string" as const, maxLength: 1000 },
        },
        keyDependencies: {
          type: "array" as const,
          maxItems: 15,
          items: { type: "string" as const, maxLength: 200 },
        },
        retrofitEvidence: {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            sourceJiraKey: {
              type: "string" as const,
              minLength: 1,
              maxLength: 80,
            },
            sourceBranch: {
              type: "string" as const,
              minLength: 1,
              maxLength: 200,
            },
            targetBranch: {
              type: "string" as const,
              minLength: 1,
              maxLength: 200,
            },
            sourcePrUrl: {
              type: "string" as const,
              minLength: 1,
              maxLength: 500,
            },
            commitSelectionMethod: {
              type: "string" as const,
              enum: [
                "source_pr",
                "source_run_pr",
                "jira_pr_link",
                "github_pr_search",
                "commit_pr_expansion",
                "subject_grep_only",
              ] as const,
            },
            sourceCommitSelectionComplete: { type: "boolean" as const },
            selectedCommits: {
              type: "array" as const,
              maxItems: 20,
              items: {
                type: "object" as const,
                additionalProperties: false,
                properties: {
                  sha: {
                    type: "string" as const,
                    minLength: 7,
                    maxLength: 40,
                  },
                  subject: {
                    type: "string" as const,
                    minLength: 1,
                    maxLength: 300,
                  },
                  files: {
                    type: "array" as const,
                    maxItems: 30,
                    items: {
                      type: "string" as const,
                      minLength: 1,
                      maxLength: 300,
                    },
                  },
                  alreadyApplied: { type: "boolean" as const },
                },
                required: ["sha", "subject"],
              },
            },
            touchedFiles: {
              type: "array" as const,
              maxItems: 50,
              items: {
                type: "string" as const,
                minLength: 1,
                maxLength: 300,
              },
            },
            alreadyApplied: { type: "boolean" as const },
            evidenceSummary: {
              type: "string" as const,
              minLength: 1,
              maxLength: 2000,
            },
          },
          required: [
            "sourceJiraKey",
            "sourceBranch",
            "targetBranch",
            "selectedCommits",
            "touchedFiles",
            "alreadyApplied",
            "evidenceSummary",
          ],
        },
        retrofitExecutionContract: {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            version: {
              type: "string" as const,
              enum: ["retrofit_execution_contract.v1"] as const,
            },
            sourceJiraKey: {
              type: "string" as const,
              minLength: 1,
              maxLength: 80,
            },
            sourceBranch: {
              type: "string" as const,
              minLength: 1,
              maxLength: 200,
            },
            targetBranch: {
              type: "string" as const,
              minLength: 1,
              maxLength: 200,
            },
            sourceRepoName: {
              type: "string" as const,
              minLength: 1,
              maxLength: 200,
            },
            sourceRepoUrl: {
              type: "string" as const,
              minLength: 1,
              maxLength: 500,
            },
            sourcePrUrl: {
              type: "string" as const,
              minLength: 1,
              maxLength: 500,
            },
            commitSelectionMethod: {
              type: "string" as const,
              enum: [
                "source_pr",
                "source_run_pr",
                "jira_pr_link",
                "github_pr_search",
                "commit_pr_expansion",
                "subject_grep_only",
              ] as const,
            },
            sourceCommitSelectionComplete: { type: "boolean" as const },
            selectedCommits: {
              type: "array" as const,
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object" as const,
                additionalProperties: false,
                properties: {
                  sha: {
                    type: "string" as const,
                    minLength: 7,
                    maxLength: 40,
                  },
                  subject: {
                    type: "string" as const,
                    minLength: 1,
                    maxLength: 300,
                  },
                  sourceFiles: {
                    type: "array" as const,
                    maxItems: 80,
                    items: { type: "string" as const, maxLength: 500 },
                  },
                  targetFiles: {
                    type: "array" as const,
                    maxItems: 80,
                    items: { type: "string" as const, maxLength: 500 },
                  },
                  adaptationFiles: {
                    type: "array" as const,
                    maxItems: 80,
                    items: { type: "string" as const, maxLength: 500 },
                  },
                  status: {
                    type: "string" as const,
                    enum: [
                      "not_attempted",
                      "already_applied",
                      "clean_applied",
                      "adapted",
                      "excluded",
                      "failed",
                      "conflicted",
                    ] as const,
                  },
                  conflictDiagnostics: {
                    type: "string" as const,
                    minLength: 1,
                    maxLength: 8000,
                  },
                  proofSnippets: {
                    type: "array" as const,
                    maxItems: 40,
                    items: { type: "string" as const, maxLength: 3000 },
                  },
                  validationEvidence: {
                    type: "array" as const,
                    maxItems: 40,
                    items: { type: "string" as const, maxLength: 3000 },
                  },
                  rationale: {
                    type: "string" as const,
                    minLength: 1,
                    maxLength: 3000,
                  },
                },
                required: ["sha", "subject"],
              },
            },
            allowedFileMappings: {
              type: "array" as const,
              maxItems: 20,
              items: {
                type: "object" as const,
                additionalProperties: false,
                properties: {
                  sourceSha: {
                    type: "string" as const,
                    minLength: 7,
                    maxLength: 40,
                  },
                  sourceFiles: {
                    type: "array" as const,
                    maxItems: 80,
                    items: { type: "string" as const, maxLength: 500 },
                  },
                  targetFiles: {
                    type: "array" as const,
                    maxItems: 80,
                    items: { type: "string" as const, maxLength: 500 },
                  },
                  adaptationFiles: {
                    type: "array" as const,
                    maxItems: 80,
                    items: { type: "string" as const, maxLength: 500 },
                  },
                  rationale: {
                    type: "string" as const,
                    minLength: 1,
                    maxLength: 3000,
                  },
                  evidence: {
                    type: "array" as const,
                    maxItems: 20,
                    items: { type: "string" as const, maxLength: 1000 },
                  },
                },
                required: ["sourceSha", "rationale"],
              },
            },
          },
          required: [
            "version",
            "sourceJiraKey",
            "sourceBranch",
            "targetBranch",
            "selectedCommits",
          ],
        },
      },
    },
    fileChangeContract: {
      type: "array" as const,
      maxItems: 60,
      items: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          path: { type: "string" as const, minLength: 1, maxLength: 500 },
          role: {
            type: "string" as const,
            enum: [
              "runtime_required",
              "test_required",
              "config_required",
              "source_parity",
              "read_only_evidence",
              "forbidden",
            ],
          },
          editable: { type: "boolean" as const },
          rationale: {
            type: "string" as const,
            minLength: 1,
            maxLength: 3000,
          },
          supportingEvidence: {
            type: "array" as const,
            maxItems: 12,
            items: {
              type: "string" as const,
              minLength: 1,
              maxLength: 1000,
            },
          },
          allowedChanges: {
            type: "array" as const,
            maxItems: 12,
            items: {
              type: "string" as const,
              minLength: 1,
              maxLength: 1000,
            },
          },
        },
        required: [
          "path",
          "role",
          "editable",
          "rationale",
          "supportingEvidence",
          "allowedChanges",
        ],
      },
    },
    plannedCodeChanges: {
      type: "array" as const,
      maxItems: 60,
      items: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          targetFile: {
            type: "string" as const,
            minLength: 1,
            maxLength: 500,
          },
          symbolOrRegion: {
            type: "string" as const,
            minLength: 1,
            maxLength: 500,
          },
          changeType: {
            type: "string" as const,
            enum: ["insert", "update", "delete", "replace", "create"],
          },
          beforeSnippet: {
            type: "string" as const,
            maxLength: 6000,
          },
          afterSketch: {
            type: "string" as const,
            minLength: 1,
            maxLength: 10000,
          },
          rationale: {
            type: "string" as const,
            minLength: 1,
            maxLength: 3000,
          },
          supportingEvidence: {
            type: "array" as const,
            minItems: 1,
            maxItems: 12,
            items: {
              type: "string" as const,
              minLength: 1,
              maxLength: 1000,
            },
          },
          confidence: {
            type: "string" as const,
            enum: ["low", "medium", "high"],
          },
        },
        required: [
          "targetFile",
          "symbolOrRegion",
          "changeType",
          "afterSketch",
          "rationale",
          "supportingEvidence",
          "confidence",
        ],
      },
    },
    plannedCodeChangeRationale: {
      type: "string" as const,
      minLength: 1,
      maxLength: 3000,
    },
    guardrailReport: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        coreChecks: {
          type: "array" as const,
          maxItems: 20,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              id: { type: "string" as const, minLength: 1, maxLength: 120 },
              severity: {
                type: "string" as const,
                enum: ["critical", "high", "medium", "low"],
              },
              status: {
                type: "string" as const,
                enum: ["passed", "warning", "failed", "not_applicable"],
              },
              applicabilityReason: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              evidence: {
                type: "array" as const,
                maxItems: 12,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 1000,
                },
              },
              requiredAction: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
            },
            required: [
              "id",
              "severity",
              "status",
              "applicabilityReason",
              "evidence",
              "requiredAction",
            ],
          },
        },
        domainChecks: {
          type: "array" as const,
          maxItems: 20,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              id: { type: "string" as const, minLength: 1, maxLength: 120 },
              severity: {
                type: "string" as const,
                enum: ["critical", "high", "medium", "low"],
              },
              status: {
                type: "string" as const,
                enum: ["passed", "warning", "failed", "not_applicable"],
              },
              applicabilityReason: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              evidence: {
                type: "array" as const,
                maxItems: 12,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 1000,
                },
              },
              requiredAction: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
            },
            required: [
              "id",
              "severity",
              "status",
              "applicabilityReason",
              "evidence",
              "requiredAction",
            ],
          },
        },
        implementerChecks: {
          type: "array" as const,
          maxItems: 20,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              id: { type: "string" as const, minLength: 1, maxLength: 120 },
              severity: {
                type: "string" as const,
                enum: ["critical", "high", "medium", "low"],
              },
              status: {
                type: "string" as const,
                enum: ["passed", "warning", "failed", "not_applicable"],
              },
              applicabilityReason: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              evidence: {
                type: "array" as const,
                maxItems: 12,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 1000,
                },
              },
              requiredAction: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
            },
            required: [
              "id",
              "severity",
              "status",
              "applicabilityReason",
              "evidence",
              "requiredAction",
            ],
          },
        },
      },
      required: ["coreChecks", "domainChecks", "implementerChecks"],
    },
    testingStrategy: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        mode: {
          type: "string" as const,
          enum: [
            "test_first",
            "focused_regression",
            "manual_verification",
            "verification_only",
          ],
        },
        existingTestEvidence: {
          type: "array" as const,
          maxItems: 20,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              id: { type: "string" as const, minLength: 1, maxLength: 120 },
              kind: {
                type: "string" as const,
                enum: [
                  "test_file",
                  "fixture",
                  "command",
                  "no_suitable_test_surface",
                ],
              },
              path: { type: "string" as const, minLength: 1, maxLength: 500 },
              command: {
                type: "string" as const,
                minLength: 1,
                maxLength: 1000,
              },
              summary: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              supportingEvidence: {
                type: "array" as const,
                maxItems: 12,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 1000,
                },
              },
            },
            required: ["id", "kind", "summary", "supportingEvidence"],
          },
        },
        plannedAutomatedTests: {
          type: "array" as const,
          maxItems: 30,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              id: { type: "string" as const, minLength: 1, maxLength: 120 },
              testFile: {
                type: "string" as const,
                minLength: 1,
                maxLength: 500,
              },
              relatedSpecIds: {
                type: "array" as const,
                maxItems: 15,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 120,
                },
              },
              testType: {
                type: "string" as const,
                enum: [
                  "unit",
                  "integration",
                  "functional",
                  "regression",
                  "security",
                  "boundary",
                ],
              },
              scenario: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              assertions: {
                type: "array" as const,
                minItems: 1,
                maxItems: 20,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 1000,
                },
              },
              failFirst: { type: "boolean" as const },
              command: {
                type: "string" as const,
                minLength: 1,
                maxLength: 1000,
              },
              syntheticDataNotes: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
            },
            required: [
              "id",
              "testFile",
              "relatedSpecIds",
              "testType",
              "scenario",
              "assertions",
              "failFirst",
              "command",
              "syntheticDataNotes",
            ],
          },
        },
        validationCommands: {
          type: "array" as const,
          maxItems: 20,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              command: {
                type: "string" as const,
                minLength: 1,
                maxLength: 1000,
              },
              expectedResult: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              scope: {
                type: "string" as const,
                enum: ["focused", "module", "full", "manual"],
              },
              relatedSpecIds: {
                type: "array" as const,
                maxItems: 15,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 120,
                },
              },
            },
            required: ["command", "expectedResult", "scope", "relatedSpecIds"],
          },
        },
        manualChecks: {
          type: "array" as const,
          maxItems: 20,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              id: { type: "string" as const, minLength: 1, maxLength: 120 },
              relatedSpecIds: {
                type: "array" as const,
                maxItems: 15,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 120,
                },
              },
              scenario: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              steps: {
                type: "array" as const,
                minItems: 1,
                maxItems: 20,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 1000,
                },
              },
              expectedResult: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              reasonNotAutomated: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
            },
            required: [
              "relatedSpecIds",
              "scenario",
              "steps",
              "expectedResult",
              "reasonNotAutomated",
            ],
          },
        },
        traceGuidance: {
          type: "array" as const,
          maxItems: 20,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              id: { type: "string" as const, minLength: 1, maxLength: 120 },
              section: { type: "string" as const, enum: ["A", "B", "C"] },
              testType: {
                type: "string" as const,
                enum: [
                  "Functional",
                  "Regression",
                  "Unit",
                  "Security",
                  "Negative",
                  "Boundary",
                ],
              },
              scenario: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              relatedSpecIds: {
                type: "array" as const,
                maxItems: 15,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 120,
                },
              },
              priority: {
                type: "string" as const,
                enum: ["Critical", "High", "Medium", "Low"],
              },
            },
            required: [
              "id",
              "section",
              "testType",
              "scenario",
              "relatedSpecIds",
              "priority",
            ],
          },
        },
        coverageGaps: {
          type: "array" as const,
          maxItems: 20,
          items: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              id: { type: "string" as const, minLength: 1, maxLength: 120 },
              relatedSpecIds: {
                type: "array" as const,
                maxItems: 15,
                items: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 120,
                },
              },
              gap: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              reason: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              risk: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
              followUp: {
                type: "string" as const,
                minLength: 1,
                maxLength: 3000,
              },
            },
            required: [
              "id",
              "relatedSpecIds",
              "gap",
              "reason",
              "risk",
              "followUp",
            ],
          },
        },
      },
      required: [
        "mode",
        "existingTestEvidence",
        "plannedAutomatedTests",
        "validationCommands",
        "manualChecks",
        "traceGuidance",
        "coverageGaps",
      ],
    },
    implementerGuardrails: {
      type: "array" as const,
      maxItems: 30,
      items: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          id: { type: "string" as const, minLength: 1, maxLength: 120 },
          instruction: {
            type: "string" as const,
            minLength: 1,
            maxLength: 3000,
          },
          appliesToFiles: {
            type: "array" as const,
            maxItems: 60,
            items: {
              type: "string" as const,
              minLength: 1,
              maxLength: 500,
            },
          },
          required: { type: "boolean" as const },
        },
        required: ["id", "instruction", "appliesToFiles", "required"],
      },
    },
  },
  required: [
    "jiraKey",
    "repoName",
    "branchName",
    "baseCommitSha",
    "summary",
    "implementationMode",
    "specs",
    "fileChangeContract",
    "plannedCodeChanges",
    "guardrailReport",
    "testingStrategy",
    "implementerGuardrails",
  ],
};

export function getPlanImpactedFiles(
  plan: Pick<OneShotPlan, "specs">,
): string[] {
  return Array.from(new Set(plan.specs.flatMap((spec) => spec.targetFiles)));
}

export function getPlanEditableFiles(
  plan: Pick<OneShotPlan, "specs" | "fileChangeContract">,
): string[] {
  const contract = plan.fileChangeContract ?? [];
  if (contract.length === 0) {
    return getPlanImpactedFiles(plan);
  }
  return Array.from(
    new Set(
      contract
        .filter(
          (entry) =>
            entry.editable &&
            entry.role !== "read_only_evidence" &&
            entry.role !== "forbidden",
        )
        .map((entry) => entry.path),
    ),
  );
}

export function getPlanValidationSteps(
  plan: Pick<OneShotPlan, "specs">,
): string[] {
  return Array.from(
    new Set(plan.specs.flatMap((spec) => spec.validationSteps)),
  );
}

function hasImplementationModeField(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "implementationMode")
  );
}

function implementationModeWasDefaulted(plan: OneShotPlan): boolean {
  return (
    plan.implementationMode === undefined ||
    (plan as OneShotPlanWithParserMetadata)[
      LEGACY_IMPLEMENTATION_MODE_DEFAULTED
    ] === true
  );
}

export function parseOneShotPlan(value: unknown): OneShotPlan {
  const hadImplementationMode = hasImplementationModeField(value);
  const plan = OneShotPlanSchema.parse(value) as OneShotPlanWithParserMetadata;
  if (!hadImplementationMode) {
    Object.defineProperty(plan, LEGACY_IMPLEMENTATION_MODE_DEFAULTED, {
      value: true,
      enumerable: false,
    });
  }
  return plan;
}

function compactPlanText(plan: OneShotPlan): string {
  return [
    plan.summary,
    ...plan.specs.flatMap((spec) => [
      spec.objective,
      ...spec.acceptanceCriteria,
      ...spec.implementationNotes,
      ...spec.validationSteps,
    ]),
    plan.plannerDiscoveries?.retrofitEvidence?.evidenceSummary ?? "",
  ]
    .join("\n")
    .toLowerCase();
}

const LEGACY_VERIFICATION_ONLY_PATTERNS: RegExp[] = [
  /\bverification[-\s]?only\b/i,
  /\bno\s+(?:repo|repository|source|code|implementation)\s+changes?\s+(?:are\s+)?(?:required|needed|necessary)\b/i,
  /\b(?:repo|repository|source|code|implementation)\s+changes?\s+(?:are\s+)?not\s+(?:required|needed|necessary)\b/i,
  /\b(?:confirm|verify|confirmed|verified)\s+no\s+(?:repo|repository|source|code|implementation|ui)\s+changes?\b/i,
  /\b(?:change|fix|remediation|dependency|version)\s+(?:is\s+|was\s+)?already\s+(?:applied|present|satisfied)\b/i,
  /\balready\s+patch[-\s]?equivalent\b/i,
];

export function getVerificationOnlyPlanReason(
  plan: OneShotPlan,
): string | null {
  if (plan.implementationMode === "verification_only") {
    return "Plan declares implementationMode=verification_only.";
  }
  if (!implementationModeWasDefaulted(plan)) {
    return null;
  }

  const text = compactPlanText(plan);
  for (const pattern of LEGACY_VERIFICATION_ONLY_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) {
      return `Legacy plan text matched "${match[0]}".`;
    }
  }

  return null;
}

export function isVerificationOnlyPlan(plan: OneShotPlan): boolean {
  return getVerificationOnlyPlanReason(plan) !== null;
}

export function parseRetrofitAlreadyAppliedEvidence(
  value: unknown,
): OneShotRetrofitEvidence | null {
  const parsed = OneShotRetrofitAlreadyAppliedOutputSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return parsed.data.plannerDiscoveries.retrofitEvidence;
}

export function buildRetrofitAlreadyAppliedMessage(
  evidence: Pick<
    OneShotRetrofitEvidence,
    "sourceJiraKey" | "sourceBranch" | "targetBranch"
  >,
): string {
  return (
    `already_applied: Retrofit source change ${evidence.sourceJiraKey} ` +
    `from ${evidence.sourceBranch} is already patch-equivalent ` +
    `on ${evidence.targetBranch}; no missing retrofit changes to plan.`
  );
}
