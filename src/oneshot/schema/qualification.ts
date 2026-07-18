import { z } from "zod";

export const QUALIFICATION_OUTPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    qualified: { type: "boolean" as const },
    templateMatched: {
      type: "string" as const,
      enum: ["cpdev_template", "retrofit_template", "none"] as const,
    },
    requirementsSummary: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    acceptanceCriteriaPresent: { type: "boolean" as const },
    blockingReasons: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    nonBlockingWarnings: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    qualificationReasoning: { type: "string" as const },
    repoSelection: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        type: {
          type: "string" as const,
          enum: [
            "explicit_github",
            "profiled_repo",
            "needs_confirmation",
            "no_match",
            "multi_repo",
          ] as const,
        },
        explicitRepoRef: { type: "string" as const },
        selectedRepoIds: {
          type: "array" as const,
          items: { type: "integer" as const },
        },
        candidateSummaries: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        repoReasoning: { type: "string" as const },
      },
      required: ["type", "repoReasoning"],
    },
    retrofitContext: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        sourceJiraKey: { type: "string" as const },
        sourceBranch: { type: "string" as const },
        targetBranch: { type: "string" as const },
        sourcePrUrl: { type: "string" as const },
      },
      required: ["sourceJiraKey", "sourceBranch", "targetBranch"],
    },
    multiRepoPlan: {
      type: "array" as const,
      items: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          repoRef: { type: "string" as const },
          objective: { type: "string" as const },
          acceptanceCriteria: {
            type: "array" as const,
            items: { type: "string" as const },
          },
          mergeOrder: { type: "integer" as const },
        },
        required: ["repoRef", "objective", "acceptanceCriteria", "mergeOrder"],
      },
    },
    multiRepoBrief: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        repoRef: { type: "string" as const },
        objective: { type: "string" as const },
        acceptanceCriteria: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        mergeOrder: { type: "integer" as const },
        runGroupId: { type: "integer" as const },
      },
      required: ["repoRef", "objective", "acceptanceCriteria", "mergeOrder"],
    },
    multiBranchRetrofitPlan: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        sourceJiraKey: { type: "string" as const },
        repoRef: { type: "string" as const },
        sourceBranch: { type: "string" as const },
        targetBranches: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        skippedTargetBranches: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: [
        "sourceJiraKey",
        "repoRef",
        "sourceBranch",
        "targetBranches",
        "skippedTargetBranches",
      ],
    },
    multiBranchRetrofitBrief: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        sourceJiraKey: { type: "string" as const },
        repoRef: { type: "string" as const },
        sourceBranch: { type: "string" as const },
        targetBranch: { type: "string" as const },
        targetOrder: { type: "integer" as const },
        totalTargets: { type: "integer" as const },
        runGroupId: { type: "integer" as const },
      },
      required: [
        "sourceJiraKey",
        "repoRef",
        "sourceBranch",
        "targetBranch",
        "targetOrder",
        "totalTargets",
      ],
    },
  },
  required: [
    "qualified",
    "templateMatched",
    "requirementsSummary",
    "acceptanceCriteriaPresent",
    "blockingReasons",
    "nonBlockingWarnings",
    "qualificationReasoning",
    "repoSelection",
  ],
};

const OptionalPositiveRepoIdSchema = z.preprocess((value) => {
  if (typeof value === "number" && value <= 0) {
    return undefined;
  }

  return value;
}, z.number().int().positive().optional());

const OptionalNonEmptyStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

export const RepoSelectionTypeSchema = z.enum([
  "explicit_github",
  "profiled_repo",
  "needs_confirmation",
  "no_match",
  "multi_repo",
]);

export type RepoSelectionType = z.infer<typeof RepoSelectionTypeSchema>;

export const RepoSelectionSchema = z.object({
  type: RepoSelectionTypeSchema,
  explicitRepoRef: OptionalNonEmptyStringSchema,
  selectedRepoIds: z.array(z.number().int().positive()).default([]),
  candidateSummaries: z.array(z.string().min(1)).default([]),
  repoReasoning: z.string().default(""),
});

export type RepoSelection = z.infer<typeof RepoSelectionSchema>;

export const RetrofitContextSchema = z.object({
  sourceJiraKey: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  sourcePrUrl: z.string().url().optional(),
});

export type RetrofitContext = z.infer<typeof RetrofitContextSchema>;

export const TemplateMatchedSchema = z.enum([
  "cpdev_template",
  "retrofit_template",
  "none",
]);

export type TemplateMatched = z.infer<typeof TemplateMatchedSchema>;

export const MultiRepoSliceSchema = z.object({
  repoRef: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  mergeOrder: z.number().int().positive(),
});

export type MultiRepoSlice = z.infer<typeof MultiRepoSliceSchema>;

export const MultiRepoBriefSchema = z.object({
  repoRef: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  mergeOrder: z.number().int().positive(),
  runGroupId: z.number().int().positive().optional(),
});

export type MultiRepoBrief = z.infer<typeof MultiRepoBriefSchema>;

export const MultiBranchRetrofitPlanSchema = z.object({
  sourceJiraKey: z.string().min(1),
  repoRef: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranches: z.array(z.string().min(1)).min(2).max(7),
  skippedTargetBranches: z.array(z.string().min(1)).default([]),
});

export type MultiBranchRetrofitPlan = z.infer<
  typeof MultiBranchRetrofitPlanSchema
>;

export const MultiBranchRetrofitBriefSchema = z.object({
  sourceJiraKey: z.string().min(1),
  repoRef: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  targetOrder: z.number().int().positive(),
  totalTargets: z.number().int().positive(),
  runGroupId: z.number().int().positive().optional(),
});

export type MultiBranchRetrofitBrief = z.infer<
  typeof MultiBranchRetrofitBriefSchema
>;

export const QualificationAssessmentSchema = z.object({
  qualified: z.boolean(),
  templateMatched: TemplateMatchedSchema.default("none"),
  // System-injected after qualification when a single repo is resolved.
  repoId: OptionalPositiveRepoIdSchema,
  branchName: OptionalNonEmptyStringSchema,
  baseCommitSha: z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }, z.string().min(7).max(40).optional()),
  requirementsSummary: z.array(z.string().min(1)).default([]),
  acceptanceCriteriaPresent: z.boolean(),
  blockingReasons: z.array(z.string().min(1)).default([]),
  nonBlockingWarnings: z.array(z.string().min(1)).default([]),
  qualificationReasoning: z.string().default(""),
  repoSelection: RepoSelectionSchema,
  retrofitContext: RetrofitContextSchema.optional(),
  // Multi-repo plan: emitted by the QUALIFIER LLM when repoSelection.type='multi_repo'.
  multiRepoPlan: z.array(MultiRepoSliceSchema).optional(),
  // Multi-repo brief: per-child-run scope injected by the worker into each child's
  // qualification artifact so the planner plans only the assigned objective.
  multiRepoBrief: MultiRepoBriefSchema.optional(),
  // Multi-branch retrofit plan: emitted by QUALIFIER when one repo should run
  // the same retrofit from one source branch to multiple target branches.
  multiBranchRetrofitPlan: MultiBranchRetrofitPlanSchema.optional(),
  // Multi-branch retrofit brief: per-child-run branch scope injected by the worker.
  multiBranchRetrofitBrief: MultiBranchRetrofitBriefSchema.optional(),
  // Legacy planner-grounding fields. QUALIFIER no longer populates these,
  // but they remain optional on the schema so planner-grounding's evidence
  // path keeps compiling and falls back to file-based scoring when absent.
  repoInspectionPerformed: z.boolean().default(false),
  inspectedFiles: z.array(z.string().min(1)).default([]),
  inspectionSummary: OptionalNonEmptyStringSchema,
});

export type QualificationAssessment = z.infer<
  typeof QualificationAssessmentSchema
>;

export function parseQualificationAssessment(
  value: unknown,
): QualificationAssessment {
  return QualificationAssessmentSchema.parse(value);
}

export function normalizeQualificationAssessment(
  value: QualificationAssessment,
): QualificationAssessment {
  // Mirror legacy normalize: enforce that `qualified=false` cannot carry
  // injected repoId/branchName/baseCommitSha. Callers who later inject those
  // for a qualified ticket still go through this function before persistence.
  if (!value.qualified) {
    return {
      ...value,
      repoId: undefined,
      branchName: undefined,
      baseCommitSha: undefined,
    };
  }
  return value;
}
