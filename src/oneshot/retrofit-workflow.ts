import type { PlannerRetrofitContext } from "./retrofit-context.js";
import type {
  RetrofitSourceCommitStatus,
  RetrofitSourceEvidence,
} from "./retrofit-source-evidence.js";
import type { OneShotPlan } from "./schema/plan.js";

export type RetrofitWorkflowStage =
  | "planner"
  | "reviewer"
  | "implementer"
  | "code_reviewer";

export interface RetrofitWorkflowSectionInput {
  workflowPrompt: string;
  stage: RetrofitWorkflowStage;
  retrofitContext?: PlannerRetrofitContext | null;
  retrofitSourceEvidence?: RetrofitSourceEvidence | null;
  plan?: Pick<OneShotPlan, "plannerDiscoveries"> | null;
  sourceJiraKey?: string | null;
  sourceBranch?: string | null;
  targetBranch?: string | null;
  selectedShas?: readonly string[] | null;
  touchedFiles?: readonly string[] | null;
  allowedFiles?: readonly string[] | null;
  priorStatuses?: readonly RetrofitSourceCommitStatus[] | null;
  conflictContext?: unknown;
}

export type RetrofitWorkflowDetectionInput = Omit<
  RetrofitWorkflowSectionInput,
  "workflowPrompt" | "stage"
>;

export function isRetrofitWorkflowRequired(
  input: RetrofitWorkflowDetectionInput,
): boolean {
  return Boolean(
    input.retrofitContext ||
      input.retrofitSourceEvidence ||
      input.plan?.plannerDiscoveries?.retrofitEvidence ||
      (input.selectedShas?.length ?? 0) > 0 ||
      (input.touchedFiles?.length ?? 0) > 0 ||
      (input.priorStatuses?.length ?? 0) > 0 ||
      input.conflictContext,
  );
}

export function buildRetrofitWorkflowSection(
  input: RetrofitWorkflowSectionInput,
): string {
  if (!isRetrofitWorkflowRequired(input)) {
    return "";
  }

  const facts = collectRetrofitFacts(input);
  const runtimeLines = [
    `- Stage: ${input.stage}`,
    facts.sourceJiraKey ? `- Source Jira key: ${facts.sourceJiraKey}` : "",
    facts.sourceBranch ? `- Source branch: ${facts.sourceBranch}` : "",
    facts.targetBranch ? `- Target branch: ${facts.targetBranch}` : "",
    facts.selectedShas.length > 0
      ? `- Selected source SHAs: ${facts.selectedShas.join(", ")}`
      : "",
    facts.touchedFiles.length > 0
      ? `- Source touched files: ${facts.touchedFiles.join(", ")}`
      : "",
    facts.allowedFiles.length > 0
      ? `- Allowed implementation/adaptation files: ${facts.allowedFiles.join(", ")}`
      : "",
    input.conflictContext ? "- Retrofit conflict/recovery context is present." : "",
  ].filter(Boolean);

  const priorStatusLines = (input.priorStatuses ?? []).map((status) => {
    const targetFiles = status.targetFiles?.length
      ? ` targetFiles=${status.targetFiles.join(",")}`
      : "";
    const adaptationFiles = status.adaptationFiles?.length
      ? ` adaptationFiles=${status.adaptationFiles.join(",")}`
      : "";
    return `- ${status.sourceSha} status=${status.status}${targetFiles}${adaptationFiles}`;
  });

  return [
    "## Required Retrofit Workflow",
    "",
    input.workflowPrompt.trim(),
    "",
    "## Retrofit Runtime Facts",
    "",
    runtimeLines.join("\n"),
    ...(priorStatusLines.length > 0
      ? ["", "### Prior Accepted Source Proof", "", priorStatusLines.join("\n")]
      : []),
  ]
    .filter((section) => section !== "")
    .join("\n");
}

function collectRetrofitFacts(input: RetrofitWorkflowSectionInput): {
  sourceJiraKey?: string;
  sourceBranch?: string;
  targetBranch?: string;
  selectedShas: string[];
  touchedFiles: string[];
  allowedFiles: string[];
} {
  const evidence = input.retrofitSourceEvidence;
  const planEvidence = input.plan?.plannerDiscoveries?.retrofitEvidence;
  const context = input.retrofitContext;
  const conflictFacts = extractConflictFacts(input.conflictContext);

  const selectedShas = dedupeStrings([
    ...(input.selectedShas ?? []),
    ...(evidence?.selectedCommits.map((commit) => commit.sha) ?? []),
    ...(planEvidence?.selectedCommits.map((commit) => commit.sha) ?? []),
    ...(input.priorStatuses?.map((status) => status.sourceSha) ?? []),
    ...conflictFacts.selectedShas,
  ]);

  const touchedFiles = dedupeStrings([
    ...(input.touchedFiles ?? []),
    ...(evidence?.touchedFiles ?? []),
    ...(planEvidence?.touchedFiles ?? []),
    ...conflictFacts.touchedFiles,
  ]);

  return {
    sourceJiraKey:
      normalizeOptional(input.sourceJiraKey) ??
      normalizeOptional(evidence?.sourceJiraKey) ??
      normalizeOptional(planEvidence?.sourceJiraKey) ??
      normalizeOptional(conflictFacts.sourceJiraKey) ??
      normalizeOptional(context?.sourceJiraKey),
    sourceBranch:
      normalizeOptional(input.sourceBranch) ??
      normalizeOptional(evidence?.sourceBranch) ??
      normalizeOptional(planEvidence?.sourceBranch) ??
      normalizeOptional(conflictFacts.sourceBranch) ??
      normalizeOptional(context?.sourceBranch),
    targetBranch:
      normalizeOptional(input.targetBranch) ??
      normalizeOptional(evidence?.targetBranch) ??
      normalizeOptional(planEvidence?.targetBranch) ??
      normalizeOptional(conflictFacts.targetBranch) ??
      normalizeOptional(context?.targetBranch),
    selectedShas,
    touchedFiles,
    allowedFiles: dedupeStrings([
      ...(input.allowedFiles ?? []),
      ...conflictFacts.allowedFiles,
    ]),
  };
}

function extractConflictFacts(value: unknown): {
  sourceJiraKey?: string;
  sourceBranch?: string;
  targetBranch?: string;
  selectedShas: string[];
  touchedFiles: string[];
  allowedFiles: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { selectedShas: [], touchedFiles: [], allowedFiles: [] };
  }

  const record = value as Record<string, unknown>;
  const perCommitStatus = Array.isArray(record.perCommitStatus)
    ? record.perCommitStatus
    : [];
  return {
    sourceJiraKey: stringValue(record.sourceJiraKey),
    sourceBranch: stringValue(record.sourceBranch),
    targetBranch: stringValue(record.targetBranch),
    selectedShas: dedupeStrings([
      ...stringArrayValue(record.selectedShas),
      ...perCommitStatus
        .map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? stringValue((entry as Record<string, unknown>).sha)
            : undefined,
        )
        .filter((sha): sha is string => !!sha),
    ]),
    touchedFiles: dedupeStrings([
      ...stringArrayValue(record.changedFiles),
      ...perCommitStatus.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return [];
        }
        const statusRecord = entry as Record<string, unknown>;
        return [
          ...stringArrayValue(statusRecord.sourceFiles),
          ...stringArrayValue(statusRecord.targetFiles),
          ...stringArrayValue(statusRecord.adaptationFiles),
        ];
      }),
    ]),
    allowedFiles: stringArrayValue(record.allowedFiles),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
