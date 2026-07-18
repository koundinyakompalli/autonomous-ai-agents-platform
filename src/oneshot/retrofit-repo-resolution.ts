import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import type { CodeRepository } from "../orchestrator/database.js";
import {
  fetchPullRequestFiles,
  fetchPullRequestCommits,
  fetchPullRequestsForCommit,
  parseGitHubPullRequestUrl,
  parseGitHubRepoUrl,
  searchMergedPullRequestsByJiraKey,
  type GitHubPullRequestCommit,
} from "./github.js";
import {
  buildAuthenticatedRepoUrl,
  getRemoteBranchHead,
  type RemoteBranchHead,
} from "./git.js";
import { getRepoMentionTokens, isOneShotRepoEnabled } from "./repo-metadata.js";
import { loadRepoProfiles } from "./repo-router/profile-loader.js";
import type { RepoProfile } from "./repo-router/types.js";
import type { TicketIntentRetrofitContext } from "./ticket-intent.js";
import {
  RETROFIT_SOURCE_EVIDENCE_PATCH_SUMMARY_LIMIT,
  RETROFIT_SOURCE_EVIDENCE_SELECTED_COMMITS_LIMIT,
  RETROFIT_SOURCE_EVIDENCE_SUMMARY_LIMIT,
  RETROFIT_SOURCE_EVIDENCE_TOUCHED_FILES_LIMIT,
  type RetrofitCommitSelectionMethod,
  type RetrofitSourceEvidence,
} from "./retrofit-source-evidence.js";

const execFileAsync = promisify(execFile);
const DEFAULT_RETROFIT_GIT_TIMEOUT_MS = 60_000;
const SOURCE_EVIDENCE_FILE_PATH_LIMIT = 300;
const SOURCE_EVIDENCE_SUBJECT_LIMIT = 300;

export interface RetrofitCommitEvidence {
  sha: string;
  subject: string;
  files?: string[];
  patchSummary?: string;
  prUrl?: string;
  alreadyApplied?: boolean;
  /** Optional runtime-only apply status set by the implementer patch lane. Not part of the LLM plan schema. */
  manifestStatus?: import('./retrofit-source-evidence.js').RetrofitCommitStatus;
}

export interface RetrofitRepoEvidenceMatch {
  repo: CodeRepository;
  sourceHead: RemoteBranchHead;
  targetHead: RemoteBranchHead;
  matchingCommits: RetrofitCommitEvidence[];
  sourcePrUrl?: string;
  commitSelectionMethod?: RetrofitCommitSelectionMethod;
  sourceCommitSelectionComplete?: boolean;
}

export type RetrofitSourcePrDiscoveryMethod =
  | "source_pr"
  | "source_run_pr"
  | "jira_pr_link"
  | "github_pr_search";

export interface RetrofitSourcePullRequestCandidate {
  prUrl: string;
  method: RetrofitSourcePrDiscoveryMethod;
}

export type RetrofitRepoBranchRole = "source" | "target";
export type RetrofitRepoBranchTokenKind =
  | "stable_prefix"
  | "full_branch"
  | "last_segment";
export type RetrofitRepoAliasSource = "profile" | "repo_metadata";

export interface RetrofitRepoProfileMatch {
  repo: CodeRepository;
  branchName: string;
  branchRole: RetrofitRepoBranchRole;
  branchToken: string;
  tokenKind: RetrofitRepoBranchTokenKind;
  matchedAlias: string;
  aliasSource: RetrofitRepoAliasSource;
  score: number;
}

export type RetrofitRepoResolutionSource =
  | "profile_alias"
  | "commit_evidence"
  | "none";

export interface RetrofitRepoResolutionMatch {
  repo: CodeRepository;
  source: Exclude<RetrofitRepoResolutionSource, "none">;
  matchingCommits: RetrofitCommitEvidence[];
  profileMatch?: RetrofitRepoProfileMatch;
  evidenceMatch?: RetrofitRepoEvidenceMatch;
  sourceEvidence?: RetrofitSourceEvidence;
}

export interface RetrofitRepoResolution {
  resolutionSource: RetrofitRepoResolutionSource;
  matches: RetrofitRepoResolutionMatch[];
  profileMatches: RetrofitRepoProfileMatch[];
  evidenceMatches: RetrofitRepoEvidenceMatch[];
  commitEvidenceInspectedRepoNames: string[];
  profileAmbiguityWarnings: string[];
  warnings: string[];
}

export interface RetrofitRepoEvidenceDependencies {
  inspectRepo?: (
    repo: CodeRepository,
    context: TicketIntentRetrofitContext,
  ) => Promise<RetrofitRepoEvidenceMatch | null>;
  profiles?: Map<string, RepoProfile>;
  sourcePullRequestCandidates?: readonly RetrofitSourcePullRequestCandidate[];
  sourcePullRequestSelectionCache?: Map<
    string,
    RetrofitSourcePullRequestSelection | null
  >;
  sourceEvidenceBundleCache?: Map<string, RetrofitSourceEvidenceBundle | null>;
}

export class RetrofitSourceEvidenceLookupError extends Error {
  public readonly retryable = true;

  constructor(
    message: string,
    public readonly causeDescription?: string,
    public readonly failureKind:
      | "source_pr_lookup_failed"
      | "source_commit_lookup_failed"
      | "source_branch_lookup_failed"
      | "target_branch_lookup_failed" = "source_commit_lookup_failed",
  ) {
    super(message);
    this.name = "RetrofitSourceEvidenceLookupError";
  }
}

function retrofitGitTimeoutMs(): number {
  const parsed = Number(process.env.ONESHOT_RETROFIT_REPO_GIT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RETROFIT_GIT_TIMEOUT_MS;
}

function exactJiraKeyPattern(jiraKey: string): string {
  const escaped = jiraKey.trim().replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return `(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`;
}

export function extractGitHubPullRequestUrlsFromText(text: string): string[] {
  const urls = new Set<string>();
  const pattern =
    /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:[/?#][^\s<>"')\]}]*)?/gi;
  for (const match of text.matchAll(pattern)) {
    urls.add(match[0].replace(/[.,;:]+$/g, ""));
  }
  return Array.from(urls);
}

export function buildRetrofitSourceCommitLogArgs(
  bareRepoPath: string,
  context: TicketIntentRetrofitContext,
): string[] {
  return [
    `--git-dir=${bareRepoPath}`,
    "log",
    "--reverse",
    "--format=%H\t%s",
    "--regexp-ignore-case",
    "--extended-regexp",
    `--grep=${exactJiraKeyPattern(context.sourceJiraKey)}`,
    "HEAD",
  ];
}

function parseGitLogEvidence(output: string): RetrofitCommitEvidence[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\t", 2);
      return { sha, subject };
    })
    .filter((commit) => commit.sha && commit.subject);
}

function parseGitNameOnly(output: string): string[] {
  return Array.from(
    new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  );
}

function truncatePatchSummary(value: string): string {
  return truncateForSchema(
    value,
    RETROFIT_SOURCE_EVIDENCE_PATCH_SUMMARY_LIMIT,
    "\n...[truncated retrofit source patch evidence]",
  );
}

function uniqueFiles(commits: RetrofitCommitEvidence[]): string[] {
  return Array.from(
    new Set(commits.flatMap((commit) => commit.files ?? [])),
  ).sort();
}

function truncateForSchema(value: string, maxLength: number, suffix: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  const suffixToUse = suffix.slice(0, maxLength);
  return `${trimmed.slice(0, Math.max(0, maxLength - suffixToUse.length))}${suffixToUse}`;
}

function schemaSafeFilePath(filePath: string): string {
  return truncateForSchema(
    filePath,
    SOURCE_EVIDENCE_FILE_PATH_LIMIT,
    "...[truncated]",
  );
}

function buildEvidenceSummary(input: {
  context: TicketIntentRetrofitContext;
  totalCommitCount: number;
  selectedCommitCount: number;
  totalTouchedFileCount: number;
  touchedFiles: string[];
  commitSelectionMethod: RetrofitCommitSelectionMethod;
  sourceCommitSelectionComplete: boolean;
}): string {
  const selectionSummary = (() => {
    switch (input.commitSelectionMethod) {
      case "source_pr":
        return "from the explicit source pull request";
      case "source_run_pr":
        return "from the source ticket's prior OneShot pull request";
      case "jira_pr_link":
        return "from a GitHub pull request link on the source Jira ticket";
      case "github_pr_search":
        return "from a GitHub merged pull request search";
      case "commit_pr_expansion":
        return "by expanding a Jira-key commit to its GitHub pull request";
      case "subject_grep_only":
      default:
        return "by Jira-key subject grep fallback";
    }
  })();
  const completeness =
    input.sourceCommitSelectionComplete
      ? "complete source commit set"
      : "partial source commit evidence";
  const commitSummary =
    input.selectedCommitCount === input.totalCommitCount
      ? `Resolved ${input.totalCommitCount} source commit(s) for ${input.context.sourceJiraKey} ${selectionSummary} (${completeness}).`
      : `Resolved ${input.selectedCommitCount} of ${input.totalCommitCount} source commit(s) for ${input.context.sourceJiraKey} ${selectionSummary}; additional commits were omitted from metadata caps (${completeness}).`;
  if (input.touchedFiles.length === 0) {
    return commitSummary + " No touched files were reported by git.";
  }

  const omittedFileCount = Math.max(
    input.totalTouchedFileCount - input.touchedFiles.length,
    0,
  );
  const fileSummary =
    ` Authoritative touched files: ${input.touchedFiles.join(", ")}.` +
    (omittedFileCount > 0
      ? ` ${omittedFileCount} additional file(s) were omitted from metadata caps.`
      : "");
  return truncateForSchema(
    commitSummary + fileSummary,
    RETROFIT_SOURCE_EVIDENCE_SUMMARY_LIMIT,
    "\n...[truncated retrofit source evidence summary]",
  );
}

function buildSourceEvidence(
  match: RetrofitRepoEvidenceMatch,
  context: TicketIntentRetrofitContext,
): RetrofitSourceEvidence {
  const allTouchedFiles = uniqueFiles(match.matchingCommits)
    .map(schemaSafeFilePath)
    .filter(Boolean);
  const touchedFiles = allTouchedFiles.slice(
    0,
    RETROFIT_SOURCE_EVIDENCE_TOUCHED_FILES_LIMIT,
  );
  const selectedCommits = match.matchingCommits
    .slice(0, RETROFIT_SOURCE_EVIDENCE_SELECTED_COMMITS_LIMIT)
    .map((commit) => ({
      sha: truncateForSchema(commit.sha, 40, ""),
      subject: truncateForSchema(
        commit.subject,
        SOURCE_EVIDENCE_SUBJECT_LIMIT,
        "...[truncated]",
      ),
      files: (commit.files ?? [])
        .map(schemaSafeFilePath)
        .filter(Boolean),
      ...(commit.patchSummary
        ? { patchSummary: truncatePatchSummary(commit.patchSummary) }
        : {}),
      ...(commit.prUrl ? { prUrl: commit.prUrl } : {}),
    }));
  return {
    sourceJiraKey: context.sourceJiraKey,
    sourceBranch: context.sourceBranch,
    targetBranch: context.targetBranch,
    sourceRepoName: match.repo.repo_name,
    sourceRepoUrl: match.repo.repo_url,
    ...(match.sourcePrUrl ? { sourcePrUrl: match.sourcePrUrl } : {}),
    commitSelectionMethod: match.commitSelectionMethod ?? "subject_grep_only",
    sourceCommitSelectionComplete:
      match.sourceCommitSelectionComplete ?? false,
    selectedCommits,
    touchedFiles,
    evidenceSummary: buildEvidenceSummary({
      context,
      totalCommitCount: match.matchingCommits.length,
      selectedCommitCount: selectedCommits.length,
      totalTouchedFileCount: allTouchedFiles.length,
      touchedFiles,
      commitSelectionMethod: match.commitSelectionMethod ?? "subject_grep_only",
      sourceCommitSelectionComplete:
        match.sourceCommitSelectionComplete ?? false,
    }),
  };
}

function normalizeToken(
  value: string,
  options: { collapseSeparators?: boolean } = {},
): string {
  let normalized = value
    .trim()
    .replace(/[`*_~]/g, "")
    .replace(/^origin\//i, "")
    .replace(/^[\s"'([{<]+|[\s"')}>\],.;:]+$/g, "");
  if (options.collapseSeparators) {
    normalized = normalized.replace(/[ _]+/g, "-").replace(/-+/g, "-");
  }
  return normalized.toLowerCase();
}

function normalizeComparableToken(value: string): string {
  return normalizeToken(value, { collapseSeparators: true });
}

function normalizeExactToken(value: string): string {
  return normalizeToken(value);
}

function isExactAliasForToken(alias: string, normalizedToken: string): boolean {
  return normalizeExactToken(alias) === normalizedToken;
}

function addBranchToken(
  tokens: Map<
    string,
    {
      token: string;
      tokenKind: RetrofitRepoBranchTokenKind;
      branchName: string;
      branchRole: RetrofitRepoBranchRole;
    }
  >,
  value: string | null | undefined,
  tokenKind: RetrofitRepoBranchTokenKind,
  branchName: string,
  branchRole: RetrofitRepoBranchRole,
): void {
  if (!value) return;
  const normalized = normalizeComparableToken(value);
  if (!normalized || normalized.length < 4) return;
  tokens.set(normalized, {
    token: normalized,
    tokenKind,
    branchName,
    branchRole,
  });
}

function addStableBranchPrefixes(
  tokens: Map<
    string,
    {
      token: string;
      tokenKind: RetrofitRepoBranchTokenKind;
      branchName: string;
      branchRole: RetrofitRepoBranchRole;
    }
  >,
  branchName: string,
  branchRole: RetrofitRepoBranchRole,
): void {
  const normalized = normalizeComparableToken(branchName);
  const candidates = [normalized];
  const lastSegment = normalized.split("/").filter(Boolean).pop();
  if (lastSegment && lastSegment !== normalized) {
    candidates.push(lastSegment);
  }

  for (const candidate of candidates) {
    const versionPrefix = candidate.match(/^(.+)-\d+(?:\.\d+)+$/i)?.[1];
    addBranchToken(
      tokens,
      versionPrefix,
      "stable_prefix",
      branchName,
      branchRole,
    );

    const namedPrefix = candidate.match(
      /^(.+)-(?:master|main|develop|dev)$/i,
    )?.[1];
    addBranchToken(
      tokens,
      namedPrefix,
      "stable_prefix",
      branchName,
      branchRole,
    );
  }
}

function profileMatchScore(
  branchRole: RetrofitRepoBranchRole,
  tokenKind: RetrofitRepoBranchTokenKind,
): number {
  if (tokenKind === "stable_prefix") {
    return branchRole === "source" ? 100 : 80;
  }
  if (tokenKind === "full_branch") {
    return branchRole === "source" ? 60 : 50;
  }
  return branchRole === "source" ? 40 : 30;
}

function buildRetrofitBranchTokens(
  context: TicketIntentRetrofitContext,
): Array<{
  branchName: string;
  branchRole: RetrofitRepoBranchRole;
  token: string;
  tokenKind: RetrofitRepoBranchTokenKind;
  score: number;
}> {
  const byBranch = [
    { branchName: context.sourceBranch.trim(), branchRole: "source" as const },
    { branchName: context.targetBranch.trim(), branchRole: "target" as const },
  ].filter((branch) => branch.branchName);
  const results: Array<{
    branchName: string;
    branchRole: RetrofitRepoBranchRole;
    token: string;
    tokenKind: RetrofitRepoBranchTokenKind;
    score: number;
  }> = [];
  const seen = new Set<string>();

  for (const { branchName, branchRole } of byBranch) {
    const tokens = new Map<
      string,
      {
        token: string;
        tokenKind: RetrofitRepoBranchTokenKind;
        branchName: string;
        branchRole: RetrofitRepoBranchRole;
      }
    >();
    addBranchToken(
      tokens,
      branchName,
      "full_branch",
      branchName,
      branchRole,
    );
    const lastSegment = branchName.split("/").filter(Boolean).pop();
    addBranchToken(
      tokens,
      lastSegment,
      "last_segment",
      branchName,
      branchRole,
    );
    addStableBranchPrefixes(tokens, branchName, branchRole);

    for (const value of tokens.values()) {
      const key = `${value.branchRole}\0${value.branchName}\0${value.token}\0${value.tokenKind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        ...value,
        score: profileMatchScore(value.branchRole, value.tokenKind),
      });
    }
  }

  return results;
}

function repoAliasTokens(
  repo: CodeRepository,
  profiles: Map<string, RepoProfile>,
): Array<{
  raw: string;
  normalized: string;
  aliasSource: RetrofitRepoAliasSource;
}> {
  const profile = profiles.get(repo.repo_name.toLowerCase());
  const aliases: Array<{ raw: string; aliasSource: RetrofitRepoAliasSource }> = [
    ...(profile?.merged.aliases ?? []).map((raw) => ({
      raw,
      aliasSource: "profile" as const,
    })),
    ...getRepoMentionTokens(repo).map((raw) => ({
      raw,
      aliasSource: "repo_metadata" as const,
    })),
  ];
  const unique = new Map<
    string,
    { raw: string; aliasSource: RetrofitRepoAliasSource }
  >();
  for (const alias of aliases) {
    const normalized = normalizeComparableToken(alias.raw);
    if (normalized && normalized.length >= 4) {
      const existing = unique.get(normalized);
      // Prefer exact hyphenated aliases in diagnostics over space-collapsed equivalents.
      if (
        !existing ||
        (!isExactAliasForToken(existing.raw, normalized) &&
          isExactAliasForToken(alias.raw, normalized))
      ) {
        unique.set(normalized, alias);
      }
    }
  }
  return Array.from(unique.entries()).map(([normalized, alias]) => ({
    raw: alias.raw,
    normalized,
    aliasSource: alias.aliasSource,
  }));
}

function profileMatchRepoScore(matches: RetrofitRepoProfileMatch[]): {
  repo: CodeRepository;
  score: number;
  matchCount: number;
}[] {
  const byRepoId = new Map<number, CodeRepository>();
  const scores = new Map<number, number>();
  const matchCounts = new Map<number, number>();
  for (const match of matches) {
    byRepoId.set(match.repo.id, match.repo);
    scores.set(match.repo.id, (scores.get(match.repo.id) ?? 0) + match.score);
    matchCounts.set(match.repo.id, (matchCounts.get(match.repo.id) ?? 0) + 1);
  }

  return Array.from(byRepoId.values()).sort((a, b) => {
    const scoreDelta = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
    const countDelta =
      (matchCounts.get(b.id) ?? 0) - (matchCounts.get(a.id) ?? 0);
    return scoreDelta || countDelta || a.repo_name.localeCompare(b.repo_name);
  }).map((repo) => ({
    repo,
    score: scores.get(repo.id) ?? 0,
    matchCount: matchCounts.get(repo.id) ?? 0,
  }));
}

function buildProfileAmbiguityWarnings(
  matches: RetrofitRepoProfileMatch[],
): string[] {
  const byToken = new Map<string, RetrofitRepoProfileMatch[]>();
  for (const match of matches) {
    const key = `${match.branchRole}\0${match.branchToken}`;
    byToken.set(key, [...(byToken.get(key) ?? []), match]);
  }

  const warnings: string[] = [];
  for (const tokenMatches of byToken.values()) {
    const repoNames = Array.from(
      new Set(tokenMatches.map((match) => match.repo.repo_name)),
    ).sort();
    if (repoNames.length <= 1) continue;
    const first = tokenMatches[0];
    warnings.push(
      `profile_ambiguity: Retrofit ${first.branchRole} branch token ${first.branchToken} matched multiple repository profiles: ${repoNames.join(", ")}.`,
    );
  }
  return warnings;
}

export async function findRetrofitRepoProfileMatches(
  context: TicketIntentRetrofitContext,
  availableRepos: CodeRepository[],
  profiles?: Map<string, RepoProfile>,
): Promise<RetrofitRepoProfileMatch[]> {
  const enabledRepos = availableRepos.filter(isOneShotRepoEnabled);
  const repoProfiles = profiles ?? (await loadRepoProfiles(enabledRepos));
  const branchTokens = buildRetrofitBranchTokens(context);
  const matches: RetrofitRepoProfileMatch[] = [];

  for (const repo of enabledRepos) {
    const aliases = repoAliasTokens(repo, repoProfiles);
    for (const branchToken of branchTokens) {
      const matchedAlias = aliases.find(
        (alias) => alias.normalized === branchToken.token,
      );
      if (!matchedAlias) continue;
      matches.push({
        repo,
        branchName: branchToken.branchName,
        branchRole: branchToken.branchRole,
        branchToken: branchToken.token,
        tokenKind: branchToken.tokenKind,
        matchedAlias: matchedAlias.raw,
        aliasSource: matchedAlias.aliasSource,
        score: branchToken.score,
      });
    }
  }

  return matches;
}

async function runGit(
  args: string[],
  cwd: string | undefined,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    ...(cwd ? { cwd } : {}),
    maxBuffer: 5 * 1024 * 1024,
    timeout: retrofitGitTimeoutMs(),
  });
  return stdout;
}

async function augmentRetrofitCommitsWithGitEvidence(
  bareRepoPath: string,
  commits: RetrofitCommitEvidence[],
): Promise<RetrofitCommitEvidence[]> {
  return Promise.all(
    commits.map(async (commit) => {
      const [nameOnly, patchSummary] = await Promise.all([
        runGit(
          [
            `--git-dir=${bareRepoPath}`,
            "show",
            "--format=",
            "--name-only",
            "--find-renames",
            "--find-copies",
            commit.sha,
          ],
          undefined,
        ).catch(() => ""),
        runGit(
          [
            `--git-dir=${bareRepoPath}`,
            "show",
            "--format=fuller",
            "--find-renames",
            "--find-copies",
            "--patch",
            "--unified=20",
            "--no-ext-diff",
            commit.sha,
          ],
          undefined,
        ).catch(() => ""),
      ]);
      const parsedNameOnly = parseGitNameOnly(nameOnly);
      return {
        ...commit,
        files:
          parsedNameOnly.length > 0
            ? parsedNameOnly
            : (commit.files ?? []),
        ...(patchSummary.trim()
          ? { patchSummary: truncatePatchSummary(patchSummary) }
          : {}),
      };
    }),
  );
}

export interface RetrofitSourcePullRequestSelectionDependencies {
  fetchPullRequestCommits?: typeof fetchPullRequestCommits;
  fetchPullRequestFiles?: typeof fetchPullRequestFiles;
}

export interface RetrofitSourcePullRequestSelection {
  commits: RetrofitCommitEvidence[];
  sourcePrUrl?: string;
  method: RetrofitCommitSelectionMethod;
  complete: boolean;
}

export interface RetrofitSourceEvidenceBundle {
  sourceHead: RemoteBranchHead;
  matchingCommits: RetrofitCommitEvidence[];
  sourcePrUrl?: string;
  commitSelectionMethod?: RetrofitCommitSelectionMethod;
  sourceCommitSelectionComplete?: boolean;
}

function buildRetrofitSourcePullRequestSelectionCacheKey(
  repo: CodeRepository,
  context: TicketIntentRetrofitContext,
  candidates: readonly RetrofitSourcePullRequestCandidate[],
): string {
  return JSON.stringify({
    repoId: repo.id,
    repoUrl: repo.repo_url,
    sourceJiraKey: context.sourceJiraKey,
    sourceBranch: context.sourceBranch,
    sourcePrUrl: context.sourcePrUrl?.trim() ?? "",
    candidates: candidates
      .map((candidate) => ({
        prUrl: candidate.prUrl.trim().toLowerCase(),
        method: candidate.method,
      }))
      .filter((candidate) => candidate.prUrl.length > 0),
  });
}

export async function resolveRetrofitSourcePullRequestSelection(
  repo: CodeRepository,
  context: TicketIntentRetrofitContext,
  candidates: readonly RetrofitSourcePullRequestCandidate[] = [],
  dependencies: RetrofitSourcePullRequestSelectionDependencies = {},
): Promise<RetrofitSourcePullRequestSelection | null> {
  const fetchCommits = dependencies.fetchPullRequestCommits ?? fetchPullRequestCommits;
  const fetchFiles = dependencies.fetchPullRequestFiles ?? fetchPullRequestFiles;
  const orderedCandidates: RetrofitSourcePullRequestCandidate[] = [];
  if (context.sourcePrUrl?.trim()) {
    orderedCandidates.push({
      prUrl: context.sourcePrUrl.trim(),
      method: "source_pr",
    });
  }
  const repoRef = parseGitHubRepoUrl(repo.repo_url);
  const seen = new Set<string>();
  for (const candidate of [...orderedCandidates, ...candidates]) {
    const prUrl = candidate.prUrl.trim();
    if (!prUrl || seen.has(prUrl.toLowerCase())) {
      continue;
    }
    seen.add(prUrl.toLowerCase());
    let parsed: ReturnType<typeof parseGitHubPullRequestUrl>;
    try {
      parsed = parseGitHubPullRequestUrl(prUrl);
    } catch {
      continue;
    }
    if (
      parsed.owner.toLowerCase() !== repoRef.owner.toLowerCase() ||
      parsed.repo.toLowerCase() !== repoRef.repo.toLowerCase()
    ) {
      continue;
    }

    try {
      const [commits, files] = await Promise.all([
        fetchCommits({
          owner: parsed.owner,
          repo: parsed.repo,
          pullNumber: parsed.pullNumber,
          timeoutMs: retrofitGitTimeoutMs(),
        }),
        fetchFiles({
          owner: parsed.owner,
          repo: parsed.repo,
          pullNumber: parsed.pullNumber,
          timeoutMs: retrofitGitTimeoutMs(),
        }),
      ]);
      return {
        commits: commits.map((commit: GitHubPullRequestCommit) => ({
          sha: commit.sha,
          subject: commit.message,
          prUrl,
          files,
        })),
        sourcePrUrl: prUrl,
        method: candidate.method,
        complete: commits.length > 0,
      };
    } catch (error) {
      throw new RetrofitSourceEvidenceLookupError(
        `source_pr_lookup_failed: Could not list source PR evidence for ${prUrl}.`,
        error instanceof Error ? error.message : String(error),
        "source_pr_lookup_failed",
      );
    }
  }

  return null;
}

async function discoverMergedSourcePullRequests(
  repo: CodeRepository,
  context: TicketIntentRetrofitContext,
): Promise<RetrofitSourcePullRequestCandidate[]> {
  const repoRef = parseGitHubRepoUrl(repo.repo_url);
  try {
    const prs = await searchMergedPullRequestsByJiraKey({
      owner: repoRef.owner,
      repo: repoRef.repo,
      jiraKey: context.sourceJiraKey,
      timeoutMs: retrofitGitTimeoutMs(),
    });
    return prs.map((pr) => ({
      prUrl: pr.htmlUrl,
      method: "github_pr_search" as const,
    }));
  } catch (error) {
    throw new RetrofitSourceEvidenceLookupError(
      `source_pr_lookup_failed: Could not search merged source pull requests for ${context.sourceJiraKey}.`,
      error instanceof Error ? error.message : String(error),
      "source_pr_lookup_failed",
    );
  }
}

async function expandGrepCommitsThroughGitHubPr(
  repo: CodeRepository,
  grepCommits: RetrofitCommitEvidence[],
): Promise<{
  commits: RetrofitCommitEvidence[];
  sourcePrUrl?: string;
  method: RetrofitCommitSelectionMethod;
  complete: boolean;
} | null> {
  const firstCommit = grepCommits[0];
  if (!firstCommit) {
    return null;
  }
  const repoRef = parseGitHubRepoUrl(repo.repo_url);
  try {
    const prs = await fetchPullRequestsForCommit({
      owner: repoRef.owner,
      repo: repoRef.repo,
      sha: firstCommit.sha,
      timeoutMs: retrofitGitTimeoutMs(),
    });
    const pr = prs[0];
    if (!pr) {
      return null;
    }
    const [commits, files] = await Promise.all([
      fetchPullRequestCommits({
        owner: pr.owner,
        repo: pr.repo,
        pullNumber: pr.pullNumber,
        timeoutMs: retrofitGitTimeoutMs(),
      }),
      fetchPullRequestFiles({
        owner: pr.owner,
        repo: pr.repo,
        pullNumber: pr.pullNumber,
        timeoutMs: retrofitGitTimeoutMs(),
      }),
    ]);
    return {
      commits: commits.map((commit) => ({
        sha: commit.sha,
        subject: commit.message,
        prUrl: pr.htmlUrl,
        files,
      })),
      sourcePrUrl: pr.htmlUrl,
      method: "commit_pr_expansion",
      complete: commits.length > 0,
    };
  } catch (error) {
    throw new RetrofitSourceEvidenceLookupError(
      `source_pr_lookup_failed: Could not expand source commit ${firstCommit.sha} to its GitHub pull request.`,
      error instanceof Error ? error.message : String(error),
      "source_pr_lookup_failed",
    );
  }
}

async function inspectRepoForRetrofitEvidence(
  repo: CodeRepository,
  context: TicketIntentRetrofitContext,
  dependencies: RetrofitRepoEvidenceDependencies = {},
): Promise<RetrofitRepoEvidenceMatch | null> {
  const sourcePullRequestCandidates =
    dependencies.sourcePullRequestCandidates ?? [];
  const sourceEvidenceCacheKey = buildRetrofitSourcePullRequestSelectionCacheKey(
    repo,
    context,
    sourcePullRequestCandidates,
  );
  let sourceEvidenceBundle:
    | RetrofitSourceEvidenceBundle
    | null
    | undefined = dependencies.sourceEvidenceBundleCache?.get(
    sourceEvidenceCacheKey,
  );

  if (sourceEvidenceBundle === undefined) {
    const sourceHead = await getRemoteBranchHead(
      repo,
      context.sourceBranch,
    ).catch((error) => {
      throw new RetrofitSourceEvidenceLookupError(
        `source_branch_lookup_failed: Source branch lookup failed for ${repo.repo_name} while resolving retrofit source evidence.`,
        error instanceof Error ? error.message : String(error),
        "source_branch_lookup_failed",
      );
    });
    if (!sourceHead) {
      dependencies.sourceEvidenceBundleCache?.set(sourceEvidenceCacheKey, null);
      return null;
    }

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "oneshot-retrofit-repo-"),
    );
    const bareRepoPath = path.join(tempRoot, "repo.git");
    try {
      await runGit(
        [
          "clone",
          "--bare",
          "--filter=blob:none",
          "--single-branch",
          "--branch",
          context.sourceBranch,
          await buildAuthenticatedRepoUrl(repo),
          bareRepoPath,
        ],
        undefined,
      );
      const sourcePrCacheKey =
        buildRetrofitSourcePullRequestSelectionCacheKey(
          repo,
          context,
          sourcePullRequestCandidates,
        );
      let discoveredPrSelection:
        | RetrofitSourcePullRequestSelection
        | null
        | undefined = dependencies.sourcePullRequestSelectionCache?.get(
        sourcePrCacheKey,
      );
      if (discoveredPrSelection === undefined) {
        const sourcePrSelection =
          await resolveRetrofitSourcePullRequestSelection(
            repo,
            context,
            sourcePullRequestCandidates,
          );
        discoveredPrSelection =
          sourcePrSelection ??
          (await resolveRetrofitSourcePullRequestSelection(
            repo,
            context,
            await discoverMergedSourcePullRequests(repo, context),
          ));
        dependencies.sourcePullRequestSelectionCache?.set(
          sourcePrCacheKey,
          discoveredPrSelection,
        );
      }
      const stdout = discoveredPrSelection
        ? ""
        : await runGit(
            buildRetrofitSourceCommitLogArgs(bareRepoPath, context),
            undefined,
          ).catch((error) => {
            throw new RetrofitSourceEvidenceLookupError(
              `source_commit_lookup_failed: Git log failed for ${repo.repo_name} while resolving ${context.sourceJiraKey}.`,
              error instanceof Error ? error.message : String(error),
              "source_commit_lookup_failed",
            );
          });
      const grepCommits = discoveredPrSelection
        ? []
        : parseGitLogEvidence(stdout);
      const prExpandedSelection =
        discoveredPrSelection ??
        (grepCommits.length > 0
          ? await expandGrepCommitsThroughGitHubPr(repo, grepCommits)
          : null);
      const selection = prExpandedSelection ?? {
        commits: grepCommits,
        method: "subject_grep_only" as const,
        complete: false,
      };
      const matchingCommits = await augmentRetrofitCommitsWithGitEvidence(
        bareRepoPath,
        selection.commits,
      );
      sourceEvidenceBundle =
        matchingCommits.length > 0
          ? {
              sourceHead,
              matchingCommits,
              ...(selection.sourcePrUrl
                ? { sourcePrUrl: selection.sourcePrUrl }
                : {}),
              commitSelectionMethod: selection.method,
              sourceCommitSelectionComplete: selection.complete,
            }
          : null;
      dependencies.sourceEvidenceBundleCache?.set(
        sourceEvidenceCacheKey,
        sourceEvidenceBundle,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (!sourceEvidenceBundle) {
    return null;
  }

  const targetHead =
    context.targetBranch.trim().length > 0
      ? await getRemoteBranchHead(repo, context.targetBranch).catch((error) => {
          throw new RetrofitSourceEvidenceLookupError(
            `target_branch_lookup_failed: Target branch lookup failed for ${repo.repo_name} while resolving retrofit target ${context.targetBranch}.`,
            error instanceof Error ? error.message : String(error),
            "target_branch_lookup_failed",
          );
        })
      : sourceEvidenceBundle.sourceHead;
  const effectiveTargetHead =
    targetHead ?? { branchName: context.targetBranch, headSha: "" };

  return {
    repo,
    sourceHead: sourceEvidenceBundle.sourceHead,
    targetHead: effectiveTargetHead,
    matchingCommits: sourceEvidenceBundle.matchingCommits,
    ...(sourceEvidenceBundle.sourcePrUrl
      ? { sourcePrUrl: sourceEvidenceBundle.sourcePrUrl }
      : {}),
    ...(sourceEvidenceBundle.commitSelectionMethod
      ? { commitSelectionMethod: sourceEvidenceBundle.commitSelectionMethod }
      : {}),
    ...(sourceEvidenceBundle.sourceCommitSelectionComplete !== undefined
      ? {
          sourceCommitSelectionComplete:
            sourceEvidenceBundle.sourceCommitSelectionComplete,
        }
      : {}),
  };
}

export async function findRetrofitRepoEvidenceMatches(
  context: TicketIntentRetrofitContext,
  availableRepos: CodeRepository[],
  dependencies: RetrofitRepoEvidenceDependencies = {},
): Promise<RetrofitRepoEvidenceMatch[]> {
  const inspect =
    dependencies.inspectRepo ??
    ((repo: CodeRepository, inspectContext: TicketIntentRetrofitContext) =>
      inspectRepoForRetrofitEvidence(repo, inspectContext, dependencies));
  const inspected = await Promise.all(
    availableRepos.filter(isOneShotRepoEnabled).map(async (repo) => ({
      repo,
      match: await inspect(repo, context).catch((error) => {
        if (error instanceof RetrofitSourceEvidenceLookupError) {
          throw error;
        }
        return null;
      }),
    })),
  );
  return inspected
    .map((result) => result.match)
    .filter((match): match is RetrofitRepoEvidenceMatch => Boolean(match));
}

function buildRetrofitEvidenceCandidates(
  enabledRepos: CodeRepository[],
  profileCandidateRepos: Array<{ repo: CodeRepository }>,
): CodeRepository[] {
  const ordered = new Map<number, CodeRepository>();
  for (const candidate of profileCandidateRepos) {
    ordered.set(candidate.repo.id, candidate.repo);
  }
  for (const repo of enabledRepos) {
    if (!ordered.has(repo.id)) {
      ordered.set(repo.id, repo);
    }
  }
  return [...ordered.values()];
}

export async function resolveRetrofitRepoMatches(
  context: TicketIntentRetrofitContext,
  availableRepos: CodeRepository[],
  dependencies: RetrofitRepoEvidenceDependencies = {},
): Promise<RetrofitRepoResolution> {
  const enabledRepos = availableRepos.filter(isOneShotRepoEnabled);
  const profileMatches = await findRetrofitRepoProfileMatches(
    context,
    enabledRepos,
    dependencies.profiles,
  );
  const profileCandidateRepos = profileMatchRepoScore(profileMatches);
  const profileAmbiguityWarnings =
    buildProfileAmbiguityWarnings(profileMatches);
  const warnings =
    profileCandidateRepos.length === 0
      ? [
          `no_profile_candidates: No retrofit branch profile aliases matched ${context.sourceBranch} or ${context.targetBranch}; commit evidence inspected enabled repositories.`,
        ]
      : [];

  if (profileCandidateRepos.length === 1) {
    const repo = profileCandidateRepos[0].repo;
    const evidenceCandidates = buildRetrofitEvidenceCandidates(
      enabledRepos,
      profileCandidateRepos,
    );
    const evidenceMatches = await findRetrofitRepoEvidenceMatches(
      context,
      evidenceCandidates,
      dependencies,
    );
    return {
      resolutionSource:
        evidenceMatches.length > 0 ? "commit_evidence" : "none",
      matches: evidenceMatches.map((match) => ({
        repo: match.repo,
        source: "commit_evidence" as const,
        matchingCommits: match.matchingCommits,
        profileMatch: profileMatches.find(
          (profileMatch) => profileMatch.repo.id === match.repo.id,
        ),
        evidenceMatch: match,
        sourceEvidence: buildSourceEvidence(match, context),
      })),
      profileMatches,
      evidenceMatches,
      commitEvidenceInspectedRepoNames: evidenceCandidates.map(
        (candidate) => candidate.repo_name,
      ),
      profileAmbiguityWarnings,
      warnings:
        evidenceMatches.length > 0
          ? warnings
          : [
              ...warnings,
              `source_evidence_missing: Retrofit ${context.sourceJiraKey} matched repository profile ${repo.repo_name}, but no exact source commit evidence was found on ${context.sourceBranch} in any OneShot-enabled repository.`,
            ],
    };
  }

  const evidenceCandidates = buildRetrofitEvidenceCandidates(
    enabledRepos,
    profileCandidateRepos,
  );
  const evidenceMatches = await findRetrofitRepoEvidenceMatches(
    context,
    evidenceCandidates,
    dependencies,
  );

  return {
    resolutionSource:
      evidenceMatches.length > 0 ? "commit_evidence" : "none",
    matches: evidenceMatches.map((match) => ({
      repo: match.repo,
      source: "commit_evidence",
      matchingCommits: match.matchingCommits,
      evidenceMatch: match,
      profileMatch: profileMatches.find(
        (profileMatch) => profileMatch.repo.id === match.repo.id,
      ),
      sourceEvidence: buildSourceEvidence(match, context),
    })),
    profileMatches,
    evidenceMatches,
    commitEvidenceInspectedRepoNames: evidenceCandidates.map(
      (repo) => repo.repo_name,
    ),
    profileAmbiguityWarnings,
    warnings,
  };
}
