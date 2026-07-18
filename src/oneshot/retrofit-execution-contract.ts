import { z } from "zod";
import type {
  RetrofitSourceCommitEvidence,
  RetrofitSourceCommitStatus,
  RetrofitSourceEvidence,
} from "./retrofit-source-evidence.js";

export const RETROFIT_EXECUTION_CONTRACT_VERSION =
  "retrofit_execution_contract.v1";

export const RetrofitCommitSelectionMethodSchema = z.enum([
  "source_pr",
  "source_run_pr",
  "jira_pr_link",
  "github_pr_search",
  "commit_pr_expansion",
  "subject_grep_only",
]);

export type RetrofitCommitSelectionMethod = z.infer<
  typeof RetrofitCommitSelectionMethodSchema
>;

export const RetrofitExecutionContractCommitSchema = z.object({
  sha: z.string().min(7).max(40),
  subject: z.string().min(1).max(300),
  sourceFiles: z.array(z.string().min(1).max(500)).default([]),
  targetFiles: z.array(z.string().min(1).max(500)).default([]),
  adaptationFiles: z.array(z.string().min(1).max(500)).default([]),
  status: z
    .enum([
      "not_attempted",
      "already_applied",
      "clean_applied",
      "adapted",
      "excluded",
      "failed",
      "conflicted",
    ])
    .default("not_attempted"),
  conflictDiagnostics: z.string().max(8_000).optional(),
  proofSnippets: z.array(z.string().min(1).max(3_000)).max(40).default([]),
  validationEvidence: z.array(z.string().min(1).max(3_000)).max(40).default([]),
  rationale: z.string().min(1).max(3_000).optional(),
});

export const RetrofitExecutionContractMappingSchema = z.object({
  sourceSha: z.string().min(7).max(40),
  sourceFiles: z.array(z.string().min(1).max(500)).default([]),
  targetFiles: z.array(z.string().min(1).max(500)).default([]),
  adaptationFiles: z.array(z.string().min(1).max(500)).default([]),
  rationale: z.string().min(1).max(3_000),
  evidence: z.array(z.string().min(1).max(1_000)).default([]),
});

export const RetrofitExecutionContractV1Schema = z.object({
  version: z.literal(RETROFIT_EXECUTION_CONTRACT_VERSION),
  sourceJiraKey: z.string().min(1).max(80),
  sourceBranch: z.string().min(1).max(200),
  targetBranch: z.string().min(1).max(200),
  sourceRepoName: z.string().min(1).max(200).optional(),
  sourceRepoUrl: z.string().min(1).max(500).optional(),
  sourcePrUrl: z.string().url().optional(),
  commitSelectionMethod: RetrofitCommitSelectionMethodSchema.default(
    "subject_grep_only",
  ),
  sourceCommitSelectionComplete: z.boolean().default(false),
  selectedCommits: z
    .array(RetrofitExecutionContractCommitSchema)
    .min(1)
    .max(20),
  allowedFileMappings: z
    .array(RetrofitExecutionContractMappingSchema)
    .default([]),
});

export type RetrofitExecutionContractV1 = z.infer<
  typeof RetrofitExecutionContractV1Schema
>;

export interface RetrofitOptionalFieldNormalizationReport {
  normalizedOptionalFields: string[];
}

function emptyOptionalFieldNormalizationReport(): RetrofitOptionalFieldNormalizationReport {
  return { normalizedOptionalFields: [] };
}

function normalizeOptionalStringField(
  record: Record<string, unknown>,
  field: string,
  path: string,
  report: RetrofitOptionalFieldNormalizationReport,
): void {
  const value = record[field];
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    delete record[field];
    report.normalizedOptionalFields.push(path);
    return;
  }
  if (trimmed !== value) {
    record[field] = trimmed;
    report.normalizedOptionalFields.push(path);
  }
}

export function normalizeRetrofitEvidenceOptionalFields(
  value: unknown,
  pathPrefix = "plannerDiscoveries.retrofitEvidence",
): { value: unknown; report: RetrofitOptionalFieldNormalizationReport } {
  const report = emptyOptionalFieldNormalizationReport();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value, report };
  }

  const evidence = { ...(value as Record<string, unknown>) };
  normalizeOptionalStringField(
    evidence,
    "sourcePrUrl",
    `${pathPrefix}.sourcePrUrl`,
    report,
  );

  return { value: evidence, report };
}

export function normalizeRetrofitExecutionContractOptionalFields(
  value: unknown,
  pathPrefix = "plannerDiscoveries.retrofitExecutionContract",
): { value: unknown; report: RetrofitOptionalFieldNormalizationReport } {
  const report = emptyOptionalFieldNormalizationReport();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value, report };
  }

  const contract = { ...(value as Record<string, unknown>) };
  for (const field of ["sourceRepoName", "sourceRepoUrl", "sourcePrUrl"]) {
    normalizeOptionalStringField(
      contract,
      field,
      `${pathPrefix}.${field}`,
      report,
    );
  }

  if (Array.isArray(contract.selectedCommits)) {
    contract.selectedCommits = contract.selectedCommits.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const commit = { ...(entry as Record<string, unknown>) };
      for (const field of ["rationale", "conflictDiagnostics"]) {
        normalizeOptionalStringField(
          commit,
          field,
          `${pathPrefix}.selectedCommits[${index}].${field}`,
          report,
        );
      }
      return commit;
    });
  }

  return { value: contract, report };
}

export interface RetrofitFileChangeContractEntryForExecution {
  path: string;
  editable?: boolean;
  role?: string;
  rationale?: string | null;
  supportingEvidence?: readonly string[];
  allowedChanges?: readonly string[];
}

export interface RetrofitExecutionEvidenceLike {
  selectedCommits: readonly Pick<RetrofitSourceCommitEvidence, "sha">[];
}

export interface RetrofitRunDetectionInput {
  retrofitContext?: unknown;
  retrofitSourceEvidence?: unknown;
  plannerDiscoveries?: {
    retrofitEvidence?: unknown;
    retrofitExecutionContract?: unknown;
  } | null;
  plan?: {
    plannerDiscoveries?: {
      retrofitEvidence?: unknown;
      retrofitExecutionContract?: unknown;
    } | null;
  } | null;
  selectedShas?: readonly string[] | null;
  priorStatuses?: readonly RetrofitSourceCommitStatus[] | null;
  conflictContext?: unknown;
}

export function isRetrofitRunContext(input: RetrofitRunDetectionInput): boolean {
  return Boolean(
    input.retrofitContext ||
      input.retrofitSourceEvidence ||
      input.plannerDiscoveries?.retrofitEvidence ||
      input.plannerDiscoveries?.retrofitExecutionContract ||
      input.plan?.plannerDiscoveries?.retrofitEvidence ||
      input.plan?.plannerDiscoveries?.retrofitExecutionContract ||
      (input.selectedShas?.length ?? 0) > 0 ||
      (input.priorStatuses?.length ?? 0) > 0 ||
      input.conflictContext,
  );
}

export function parseRetrofitExecutionContract(
  value: unknown,
): RetrofitExecutionContractV1 | null {
  const parsed = RetrofitExecutionContractV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildRetrofitExecutionContractFromEvidence(input: {
  evidence: RetrofitSourceEvidence;
  fileChangeContract?: readonly RetrofitFileChangeContractEntryForExecution[];
}): RetrofitExecutionContractV1 {
  const mappings = buildMappingsFromEvidenceAndContract(
    input.evidence.selectedCommits,
    input.fileChangeContract ?? [],
  );
  return {
    version: RETROFIT_EXECUTION_CONTRACT_VERSION,
    sourceJiraKey: input.evidence.sourceJiraKey,
    sourceBranch: input.evidence.sourceBranch,
    targetBranch: input.evidence.targetBranch,
    sourceRepoName: optionalNonBlankString(input.evidence.sourceRepoName),
    sourceRepoUrl: optionalNonBlankString(input.evidence.sourceRepoUrl),
    sourcePrUrl: optionalNonBlankString(input.evidence.sourcePrUrl),
    commitSelectionMethod:
      input.evidence.commitSelectionMethod ?? "subject_grep_only",
    sourceCommitSelectionComplete:
      input.evidence.sourceCommitSelectionComplete ?? false,
    selectedCommits: input.evidence.selectedCommits.map((commit) => {
      const mapping = mappings.find((entry) => entry.sourceSha === commit.sha);
      return {
        sha: commit.sha,
        subject: commit.subject,
        sourceFiles: normalizeStringList(commit.files),
        targetFiles: mapping?.targetFiles ?? normalizeStringList(commit.files),
        adaptationFiles: mapping?.adaptationFiles ?? [],
        status: "not_attempted",
        rationale: mapping?.rationale,
        proofSnippets: [],
        validationEvidence: [],
      };
    }),
    allowedFileMappings: mappings,
  };
}

export function mergeRetrofitExecutionContractWithStatuses(input: {
  contract: RetrofitExecutionContractV1;
  statuses?: readonly RetrofitSourceCommitStatus[] | null;
}): RetrofitExecutionContractV1 {
  if (!input.statuses?.length) {
    return input.contract;
  }
  const statusesBySha = new Map(
    input.statuses.map((status) => [status.sourceSha.trim(), status] as const),
  );
  return {
    ...input.contract,
    selectedCommits: input.contract.selectedCommits.map((commit) => {
      const status = statusesBySha.get(commit.sha);
      if (!status) {
        return commit;
      }
      return {
        ...commit,
        status: status.status,
        sourceFiles: coalesceLists(status.sourceFiles, commit.sourceFiles),
        targetFiles: coalesceLists(status.targetFiles, commit.targetFiles),
        adaptationFiles: coalesceLists(
          status.adaptationFiles,
          commit.adaptationFiles,
        ),
        conflictDiagnostics:
          status.conflictDiagnostics ?? commit.conflictDiagnostics,
        proofSnippets: coalesceLists(status.proofSnippets, commit.proofSnippets),
        validationEvidence: coalesceLists(
          status.validationEvidence,
          commit.validationEvidence,
        ),
        rationale: status.rationale ?? commit.rationale,
      };
    }),
  };
}

export function deriveRetrofitAllowedFilesFromExecutionContract(
  contract: RetrofitExecutionContractV1 | null | undefined,
): string[] {
  if (!contract) {
    return [];
  }
  return normalizeStringList([
    ...contract.selectedCommits.flatMap((commit) => [
      ...commit.sourceFiles,
      ...commit.targetFiles,
      ...commit.adaptationFiles,
    ]),
    ...contract.allowedFileMappings.flatMap((mapping) => [
      ...mapping.sourceFiles,
      ...mapping.targetFiles,
      ...mapping.adaptationFiles,
    ]),
  ]);
}

export function validateRetrofitExecutionContractForPlan(input: {
  contract: RetrofitExecutionContractV1 | null | undefined;
  evidence: RetrofitExecutionEvidenceLike | null | undefined;
  fileChangeContract?: readonly RetrofitFileChangeContractEntryForExecution[];
  changedFiles?: readonly string[];
  requireContract?: boolean;
}): string[] {
  const evidence = input.evidence ?? null;
  const contract = input.contract ?? null;
  if (!evidence && !contract) {
    return [];
  }
  if (!contract) {
    return input.requireContract === false
      ? []
      : [
          "retrofit_contract_missing: Retrofit plans must include plannerDiscoveries.retrofitExecutionContract.",
        ];
  }

  const violations: string[] = [];
  const contractBySha = new Map(
    contract.selectedCommits.map((commit) => [commit.sha.trim(), commit]),
  );

  for (const sourceCommit of evidence?.selectedCommits ?? []) {
    const mapped = contractBySha.get(sourceCommit.sha.trim());
    if (!mapped) {
      violations.push(
        `retrofit_contract_missing_source_commit: Source commit ${sourceCommit.sha} is missing from retrofitExecutionContract.`,
      );
    }
  }

  for (const commit of contract.selectedCommits) {
    const sourceSha = commit.sha.trim();
    const hasTarget = commit.targetFiles.some((file) => file.trim());
    const hasAdaptation = commit.adaptationFiles.some((file) => file.trim());
    const excluded =
      commit.status === "excluded" && Boolean(commit.rationale?.trim());

    if (
      commit.status === "not_attempted" ||
      commit.status === "failed" ||
      commit.status === "conflicted" ||
      (commit.status === "excluded" && !commit.rationale?.trim())
    ) {
      violations.push(
        `retrofit_contract_invalid_status: Source commit ${sourceSha} has non-terminal or unaccounted status ${commit.status}.`,
      );
    }
    if (!excluded && !hasTarget && !hasAdaptation) {
      violations.push(
        `retrofit_contract_missing_mapping: Source commit ${sourceSha} must map to targetFiles, adaptationFiles, or excluded rationale.`,
      );
    }
  }

  const editableContract = new Map(
    (input.fileChangeContract ?? [])
      .filter(
        (entry) =>
          entry.editable &&
          entry.role !== "read_only_evidence" &&
          entry.role !== "forbidden",
      )
      .map((entry) => [normalizePathKey(entry.path), entry] as const),
  );
  const sourceFiles = new Set(
    contract.selectedCommits
      .flatMap((commit) => commit.sourceFiles)
      .map(normalizePathKey),
  );
  const mappedFiles = new Set(
    deriveRetrofitAllowedFilesFromExecutionContract(contract).map(normalizePathKey),
  );

  const adaptationRequirements = collectAdaptationRequirements(contract);
  for (const requirement of adaptationRequirements) {
    const contractEntry = editableContract.get(normalizePathKey(requirement.file));
    if (!contractEntry) {
      violations.push(
        `retrofit_contract_missing_file_contract: Adaptation file ${requirement.file} must have an editable fileChangeContract entry.`,
      );
      continue;
    }
    if (
      !entryReferencesSourceEvidence(contractEntry, requirement, contract)
    ) {
      violations.push(
        `retrofit_contract_weak_adaptation_evidence: Adaptation file ${requirement.file} must cite source SHA, source Jira, or source file evidence.`,
      );
    }
  }

  for (const file of input.changedFiles ?? []) {
    const key = normalizePathKey(file);
    if (!sourceFiles.has(key) && !mappedFiles.has(key)) {
      violations.push(
        `retrofit_contract_scope_violation: Changed file ${file} is not mapped to selected source commit evidence.`,
      );
    }
  }

  return violations;
}

function collectAdaptationRequirements(
  contract: RetrofitExecutionContractV1,
): Array<{
  file: string;
  sourceSha: string;
  sourceFiles: string[];
}> {
  const requirements = new Map<
    string,
    {
      file: string;
      sourceSha: string;
      sourceFiles: string[];
    }
  >();
  const addRequirement = (input: {
    file: string;
    sourceSha: string;
    sourceFiles: readonly string[];
  }) => {
    const key = `${input.sourceSha.trim()}\0${normalizePathKey(input.file)}`;
    if (requirements.has(key)) {
      return;
    }
    requirements.set(key, {
      file: input.file,
      sourceSha: input.sourceSha,
      sourceFiles: normalizeStringList(input.sourceFiles),
    });
  };

  for (const commit of contract.selectedCommits) {
    for (const file of commit.adaptationFiles) {
      addRequirement({
        file,
        sourceSha: commit.sha,
        sourceFiles: commit.sourceFiles,
      });
    }
  }
  for (const mapping of contract.allowedFileMappings) {
    for (const file of mapping.adaptationFiles) {
      addRequirement({
        file,
        sourceSha: mapping.sourceSha,
        sourceFiles: mapping.sourceFiles,
      });
    }
  }
  return Array.from(requirements.values());
}

function buildMappingsFromEvidenceAndContract(
  commits: readonly RetrofitSourceCommitEvidence[],
  fileChangeContract: readonly RetrofitFileChangeContractEntryForExecution[],
): RetrofitExecutionContractV1["allowedFileMappings"] {
  const sourceFilesBySha = new Map(
    commits.map((commit) => [commit.sha, normalizeStringList(commit.files)]),
  );
  const sourceFileKeys = new Set(
    commits.flatMap((commit) => commit.files.map(normalizePathKey)),
  );
  const mappings: RetrofitExecutionContractV1["allowedFileMappings"] = commits.map(
    (commit) => {
      const adaptationFiles = fileChangeContract
        .filter((entry) => isEditableAdaptationEntry(entry, sourceFileKeys))
        .filter((entry) => entryReferencesCommit(entry, commit))
        .map((entry) => entry.path);
      return {
        sourceSha: commit.sha,
        sourceFiles: sourceFilesBySha.get(commit.sha) ?? [],
        targetFiles: sourceFilesBySha.get(commit.sha) ?? [],
        adaptationFiles: normalizeStringList(adaptationFiles),
        rationale:
          adaptationFiles.length > 0
            ? `Planner mapped ${commit.sha} to target-branch adaptation files.`
            : `Planner mapped ${commit.sha} to source-equivalent target files.`,
        evidence: [
          commit.sha,
          ...normalizeStringList(commit.files).slice(0, 8),
        ],
      };
    },
  );
  return mappings;
}

function isEditableAdaptationEntry(
  entry: RetrofitFileChangeContractEntryForExecution,
  sourceFileKeys: ReadonlySet<string>,
): boolean {
  if (!entry.editable) {
    return false;
  }
  if (entry.role === "read_only_evidence" || entry.role === "forbidden") {
    return false;
  }
  return Boolean(entry.path?.trim()) && !sourceFileKeys.has(normalizePathKey(entry.path));
}

function entryReferencesCommit(
  entry: RetrofitFileChangeContractEntryForExecution,
  commit: RetrofitSourceCommitEvidence,
): boolean {
  const haystack = entryEvidenceText(entry);
  if (!haystack) {
    return false;
  }
  if (haystack.includes(commit.sha.toLowerCase())) {
    return true;
  }
  return commit.files.some((file) => {
    const normalized = file.toLowerCase();
    const basename = normalized.split("/").filter(Boolean).pop();
    return Boolean(
      normalized && (haystack.includes(normalized) || (basename && haystack.includes(basename))),
    );
  });
}

function entryReferencesSourceEvidence(
  entry: RetrofitFileChangeContractEntryForExecution,
  requirement: {
    sourceSha: string;
    sourceFiles: readonly string[];
  },
  contract: RetrofitExecutionContractV1,
): boolean {
  const haystack = entryEvidenceText(entry);
  if (!haystack) {
    return false;
  }
  if (
    haystack.includes(requirement.sourceSha.toLowerCase()) ||
    haystack.includes(contract.sourceJiraKey.toLowerCase())
  ) {
    return true;
  }
  return requirement.sourceFiles.some((file) => {
    const normalized = file.toLowerCase();
    const basename = normalized.split("/").filter(Boolean).pop();
    return Boolean(
      normalized && (haystack.includes(normalized) || (basename && haystack.includes(basename))),
    );
  });
}

function entryEvidenceText(
  entry: RetrofitFileChangeContractEntryForExecution,
): string {
  return [
    entry.path,
    entry.rationale ?? "",
    ...(entry.supportingEvidence ?? []),
    ...(entry.allowedChanges ?? []),
  ]
    .join("\n")
    .toLowerCase();
}

function coalesceLists(
  preferred: readonly string[] | undefined,
  fallback: readonly string[] | undefined,
): string[] {
  const normalized = normalizeStringList(preferred ?? []);
  return normalized.length > 0 ? normalized : normalizeStringList(fallback ?? []);
}

function normalizeStringList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizePathKey(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function optionalNonBlankString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePathKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}
