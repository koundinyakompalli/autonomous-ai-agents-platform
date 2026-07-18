import { z } from "zod";
import {
  deriveRetrofitAllowedFilesFromExecutionContract,
  parseRetrofitExecutionContract,
  type RetrofitExecutionContractV1,
} from "./retrofit-execution-contract.js";

export const RETROFIT_SOURCE_EVIDENCE_SELECTED_COMMITS_LIMIT = 20;
export const RETROFIT_SOURCE_EVIDENCE_TOUCHED_FILES_LIMIT = 80;
export const RETROFIT_SOURCE_EVIDENCE_PATCH_SUMMARY_LIMIT = 20_000;
export const RETROFIT_SOURCE_EVIDENCE_SUMMARY_LIMIT = 4_000;

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

export const RetrofitSourceCommitEvidenceSchema = z.object({
  sha: z.string().min(7).max(40),
  subject: z.string().min(1).max(300),
  files: z.array(z.string().min(1).max(300)).default([]),
  patchSummary: z
    .string()
    .min(1)
    .max(RETROFIT_SOURCE_EVIDENCE_PATCH_SUMMARY_LIMIT)
    .optional(),
  prUrl: z.string().url().optional(),
  alreadyApplied: z.boolean().optional(),
});

export const RetrofitSourceEvidenceSchema = z.object({
  sourceJiraKey: z.string().min(1).max(80),
  sourceBranch: z.string().min(1).max(200),
  targetBranch: z.string().min(1).max(200),
  sourceRepoName: z.string().min(1).max(200),
  sourceRepoUrl: z.string().min(1).max(500),
  sourcePrUrl: z.string().url().optional(),
  commitSelectionMethod: RetrofitCommitSelectionMethodSchema.default(
    "subject_grep_only",
  ),
  sourceCommitSelectionComplete: z.boolean().default(false),
  selectedCommits: z
    .array(RetrofitSourceCommitEvidenceSchema)
    .min(1)
    .max(RETROFIT_SOURCE_EVIDENCE_SELECTED_COMMITS_LIMIT),
  touchedFiles: z
    .array(z.string().min(1).max(300))
    .max(RETROFIT_SOURCE_EVIDENCE_TOUCHED_FILES_LIMIT)
    .default([]),
  evidenceSummary: z.string().min(1).max(RETROFIT_SOURCE_EVIDENCE_SUMMARY_LIMIT),
});

export type RetrofitSourceCommitEvidence = z.infer<
  typeof RetrofitSourceCommitEvidenceSchema
>;

export type RetrofitSourceEvidence = z.infer<
  typeof RetrofitSourceEvidenceSchema
>;

export const RetrofitAdaptationCoverageEntrySchema = z.object({
  sourceSha: z.string().min(7).max(40),
  filesCovered: z.array(z.string().min(1).max(500)).min(1).max(40),
  hunkEvidence: z.array(z.string().min(1).max(3000)).min(1).max(40),
  rationale: z.string().min(1).max(3000).optional(),
});

export const RetrofitAdaptationCoverageSchema = z
  .array(RetrofitAdaptationCoverageEntrySchema)
  .max(20);

export type RetrofitAdaptationCoverageEntry = z.infer<
  typeof RetrofitAdaptationCoverageEntrySchema
>;

export const RetrofitSourceCommitStatusSchema = z.object({
  sourceSha: z.string().min(7).max(40),
  status: z.enum([
    "already_applied",
    "clean_applied",
    "adapted",
    "excluded",
    "failed",
  ]),
  sourceFiles: z.array(z.string().min(1).max(500)).max(80).default([]),
  targetFiles: z.array(z.string().min(1).max(500)).max(80).default([]),
  adaptationFiles: z.array(z.string().min(1).max(500)).max(80).default([]),
  conflictDiagnostics: z.string().max(8_000).optional(),
  proofSnippets: z.array(z.string().min(1).max(3_000)).max(40).default([]),
  validationEvidence: z.array(z.string().min(1).max(3_000)).max(40).default([]),
  rationale: z.string().min(1).max(3_000).optional(),
});

export const RetrofitSourceCommitStatusesSchema = z
  .array(RetrofitSourceCommitStatusSchema)
  .max(RETROFIT_SOURCE_EVIDENCE_SELECTED_COMMITS_LIMIT);

export type RetrofitSourceCommitStatus = z.infer<
  typeof RetrofitSourceCommitStatusSchema
>;

export interface RetrofitFileChangeContractEntry {
  path: string;
  editable?: boolean;
  role?: string;
  rationale?: string | null;
}

export function parseRetrofitSourceEvidence(
  value: unknown,
): RetrofitSourceEvidence | null {
  const parsed = RetrofitSourceEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function addNormalizedPath(paths: Set<string>, value: string | undefined): void {
  const normalized = value?.trim();
  if (normalized) {
    paths.add(normalized);
  }
}

export function deriveRetrofitAllowedFiles(
  evidence: Pick<RetrofitSourceEvidence, "touchedFiles"> | null | undefined,
  fileChangeContract: readonly RetrofitFileChangeContractEntry[] = [],
  executionContract?: RetrofitExecutionContractV1 | null,
): string[] {
  if (executionContract) {
    return deriveRetrofitAllowedFilesFromExecutionContract(executionContract);
  }
  if (!evidence) {
    return [];
  }

  const allowed = new Set<string>();
  for (const file of evidence.touchedFiles ?? []) {
    addNormalizedPath(allowed, file);
  }

  for (const entry of fileChangeContract) {
    if (!entry.editable) {
      continue;
    }
    if (entry.role === "read_only_evidence" || entry.role === "forbidden") {
      continue;
    }
    if (!entry.rationale?.trim()) {
      continue;
    }
    addNormalizedPath(allowed, entry.path);
  }

  return Array.from(allowed);
}

export function parseRetrofitExecutionContractFromUnknown(
  value: unknown,
): RetrofitExecutionContractV1 | null {
  return parseRetrofitExecutionContract(value);
}

export function hasRetrofitAdaptationCoverage(
  value: unknown,
  sourceSha: string,
): boolean {
  const normalizedSha = sourceSha.trim();
  if (!normalizedSha) {
    return false;
  }

  const parsed = RetrofitAdaptationCoverageSchema.safeParse(value);
  if (!parsed.success) {
    return false;
  }

  return parsed.data.some(
    (entry) =>
      entry.sourceSha.trim() === normalizedSha &&
      entry.filesCovered.some((file) => file.trim()) &&
      entry.hunkEvidence.some((evidence) => evidence.trim()),
  );
}

export function parseRetrofitAdaptationCoverage(
  value: unknown,
): RetrofitAdaptationCoverageEntry[] {
  const parsed = RetrofitAdaptationCoverageSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function parseRetrofitSourceCommitStatuses(
  value: unknown,
): RetrofitSourceCommitStatus[] {
  const parsed = RetrofitSourceCommitStatusesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

// ---------------------------------------------------------------------------
// Runtime-only retrofit commit status / manifest types
// NOT added to the Zod plan schema (schema/plan.ts) — purely runtime.
// ---------------------------------------------------------------------------

/**
 * Per-commit apply status for the implementer retrofit lane.
 * - already_applied: patch-equivalent content already present on target branch
 * - clean_applied:   mechanically applied without any LLM involvement
 * - adapted:         applied with LLM adaptation (conflict resolution)
 * - excluded:        deliberately excluded with a durable rationale
 * - failed:          apply failed and could not be resolved
 * - not_attempted:   not yet processed (initial state)
 */
export type RetrofitCommitStatus =
  | 'already_applied'
  | 'clean_applied'
  | 'adapted'
  | 'excluded'
  | 'failed'
  | 'not_attempted'

/** A single entry in the per-run RetrofitCommitManifest. */
export interface RetrofitCommitManifestEntry {
  sha: string
  subject: string
  files: string[]
  status: RetrofitCommitStatus
  /** Rationale for deliberately excluding this commit (allows it to be unaccounted without flagging). */
  excludedRationale?: string
  sourceFiles?: string[]
  targetFiles?: string[]
  adaptationFiles?: string[]
  conflictDiagnostics?: string
  proofSnippets?: string[]
  validationEvidence?: string[]
  rationale?: string
}

/**
 * Ordered (oldest-to-newest) manifest of every selected source commit,
 * built by the implementer before applying any patches.
 */
export interface RetrofitCommitManifest {
  entries: RetrofitCommitManifestEntry[]
}

/**
 * Returns entries that are not yet accounted for — i.e., commits that are
 * neither successfully handled (already_applied / clean_applied / adapted)
 * nor explicitly excluded with a rationale.
 */
export function findUnaccountedRetrofitCommits(
  manifest: RetrofitCommitManifest,
): RetrofitCommitManifestEntry[] {
  return manifest.entries.filter(
    (entry) =>
      ((entry.status === 'failed' || entry.status === 'not_attempted') &&
        !entry.excludedRationale) ||
      (entry.status === 'excluded' &&
        !entry.excludedRationale &&
        !entry.rationale),
  )
}

export function formatRetrofitSourceEvidenceForPrompt(
  evidence: RetrofitSourceEvidence,
): string {
  const commitLines = evidence.selectedCommits.flatMap((commit, index) => [
    `### Source Commit ${index + 1}`,
    `- SHA: ${commit.sha}`,
    `- Subject: ${commit.subject}`,
    ...(commit.prUrl ? [`- PR: ${commit.prUrl}`] : []),
    `- Files: ${commit.files.length > 0 ? commit.files.map((file) => `\`${file}\``).join(", ") : "none recorded"}`,
    ...(commit.patchSummary
      ? ["", "```diff", commit.patchSummary, "```"]
      : []),
  ]);

  return [
    "## Retrofit Source Evidence",
    "",
    `- Source Jira key: ${evidence.sourceJiraKey}`,
    `- Source repo: ${evidence.sourceRepoName} (${evidence.sourceRepoUrl})`,
    `- Source branch: origin/${evidence.sourceBranch}`,
    `- Target branch: origin/${evidence.targetBranch}`,
    ...(evidence.sourcePrUrl ? [`- Source PR: ${evidence.sourcePrUrl}`] : []),
    `- Touched files: ${evidence.touchedFiles.map((file) => `\`${file}\``).join(", ")}`,
    "",
    evidence.evidenceSummary,
    "",
    ...commitLines,
  ].join("\n");
}
