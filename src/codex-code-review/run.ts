import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { glob } from "glob";
import OpenAI from "openai";
import { z } from "zod";
import { JiraClient, type JiraTicketData } from "../orchestrator/JiraClient.js";
import { runOpenAiAgent } from "../openai-sdk/index.js";
import type { OpenAiFunctionCall } from "../openai-sdk/repo-tools.js";
import { parseGitHubPullRequestUrl } from "../oneshot/github.js";
import { calculateUsageCostUsd } from "../oneshot/pricing.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "xhigh";
const DEFAULT_OUTPUT_DIR = "codex-code-review-output";
const GITHUB_API_BASE_URL = "https://api.github.com";
const MAX_DIFF_CHARS = 260_000;
const MAX_RULES_CHARS = 140_000;
const MAX_FILE_CONTENT_CHARS = 180_000;
const MAX_TICKET_CHARS = 90_000;
const MAX_PROMPT_BYTES = 750_000;
const MAX_WRITE_FILE_BYTES = 600_000;
const MAX_FIX_TOOL_ITERATIONS = 40;
const MAX_FIX_TOOL_TEXT_BYTES = 96_000;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const FIX_AGENT_FINALIZATION_PROMPT =
  "The repository tool-call budget is exhausted. Do not request more tools. Return the required JSON now using only changes already present in the workspace. Set applied to true only if all safe intended fixes are complete; otherwise set it to false and list every unfinished item in residualRisks.";

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);

export interface CodexCodeReviewArgs {
  phase: "review" | "apply";
  jiraTicket: string;
  prLink: string;
  outputDir: string;
  reviewDir: string;
  postPrComment: boolean;
}

export interface GitHubPullRequestInfo {
  owner: string;
  repo: string;
  pullNumber: number;
  htmlUrl: string;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  headOwner: string;
  headRepo: string;
  headRepoFullName: string;
  author: string;
}

export interface GitHubPullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface RuleDocument {
  path: string;
  content: string;
  truncated: boolean;
}

export interface ChangedFileSnapshot {
  path: string;
  status: string;
  content: string;
  truncated: boolean;
}

export interface FixCommitResult {
  committed: boolean;
  pushed: boolean;
  commitSha: string | null;
  repository: string;
  branch: string;
  changedFiles: string[];
  diffStat: string;
}

const FindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.string().min(1),
  file: z.string().nullable(),
  line: z.number().int().nonnegative().nullable(),
  description: z.string().min(1),
  recommendation: z.string().min(1),
  evidence: z.string().min(1),
  relatedRule: z.string().nullable(),
});

const JiraAskCoverageSchema = z.object({
  requirement: z.string().min(1),
  status: z.enum(["satisfied", "partial", "missing", "unclear"]),
  evidence: z.string().min(1),
});

export const CodexCodeReviewSchema = z.object({
  verdict: z.enum(["APPROVED", "NEEDS_CHANGES", "BLOCKED"]),
  summary: z.string().min(1),
  jiraAskCoverage: z.array(JiraAskCoverageSchema),
  missingOrIncorrect: z.array(FindingSchema),
  ruleViolations: z.array(FindingSchema),
  implementationFindings: z.array(FindingSchema),
  testVerification: z.array(z.string().min(1)),
  riskNotes: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
});

export type CodexCodeReview = z.infer<typeof CodexCodeReviewSchema>;

export const CodexCodeReviewFixResultSchema = z.object({
  applied: z.boolean(),
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
  verificationNotes: z.array(z.string().min(1)),
  residualRisks: z.array(z.string().min(1)),
});

export type CodexCodeReviewFixResult = z.infer<
  typeof CodexCodeReviewFixResultSchema
>;

const CodexCodeReviewUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
});

export type CodexCodeReviewUsage = z.infer<typeof CodexCodeReviewUsageSchema>;

const GitHubPullRequestInfoArtifactSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  htmlUrl: z.string().url(),
  title: z.string(),
  body: z.string(),
  state: z.string().min(1),
  draft: z.boolean(),
  baseRef: z.string(),
  baseSha: z.string(),
  headRef: z.string().min(1),
  headSha: z.string().min(1),
  headOwner: z.string().min(1),
  headRepo: z.string().min(1),
  headRepoFullName: z.string().min(1),
  author: z.string(),
});

const CodexCodeReviewMetadataSchema = z
  .object({
    jiraTicket: z.string().min(1),
    pr: GitHubPullRequestInfoArtifactSchema,
    model: z.string().min(1),
    reasoningEffort: z.string().min(1),
    usage: z
      .object({
        review: CodexCodeReviewUsageSchema.nullable(),
        apply: CodexCodeReviewUsageSchema.nullable().optional(),
      })
      .optional(),
  })
  .passthrough();

interface CodexCodeReviewHandoff {
  review: CodexCodeReview;
  metadata: Record<string, unknown>;
  jiraTicket: string;
  pr: GitHubPullRequestInfo;
  model: string;
  reasoningEffort: string;
  reviewUsage: CodexCodeReviewUsage | null;
}

const CODEX_CODE_REVIEW_OUTPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string" as const,
      enum: ["APPROVED", "NEEDS_CHANGES", "BLOCKED"],
    },
    summary: { type: "string" as const },
    jiraAskCoverage: {
      type: "array" as const,
      items: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          requirement: { type: "string" as const },
          status: {
            type: "string" as const,
            enum: ["satisfied", "partial", "missing", "unclear"],
          },
          evidence: { type: "string" as const },
        },
        required: ["requirement", "status", "evidence"],
      },
    },
    missingOrIncorrect: findingsJsonSchema(),
    ruleViolations: findingsJsonSchema(),
    implementationFindings: findingsJsonSchema(),
    testVerification: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    riskNotes: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    evidence: {
      type: "array" as const,
      items: { type: "string" as const },
    },
  },
  required: [
    "verdict",
    "summary",
    "jiraAskCoverage",
    "missingOrIncorrect",
    "ruleViolations",
    "implementationFindings",
    "testVerification",
    "riskNotes",
    "evidence",
  ],
};

const CODEX_CODE_REVIEW_FIX_OUTPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    applied: { type: "boolean" as const },
    summary: { type: "string" as const },
    changedFiles: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    verificationNotes: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    residualRisks: {
      type: "array" as const,
      items: { type: "string" as const },
    },
  },
  required: [
    "applied",
    "summary",
    "changedFiles",
    "verificationNotes",
    "residualRisks",
  ],
};

function findingsJsonSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
        },
        category: { type: "string" },
        file: { type: ["string", "null"] },
        line: { type: ["number", "null"] },
        description: { type: "string" },
        recommendation: { type: "string" },
        evidence: { type: "string" },
        relatedRule: { type: ["string", "null"] },
      },
      required: [
        "severity",
        "category",
        "file",
        "line",
        "description",
        "recommendation",
        "evidence",
        "relatedRule",
      ],
    },
  };
}

export function parseArgs(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): CodexCodeReviewArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const eqIndex = arg.indexOf("=");
    if (eqIndex > 0) {
      values.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      values.set(arg.slice(2), next);
      i += 1;
    } else {
      values.set(arg.slice(2), "true");
    }
  }

  const jiraTicket =
    values.get("jira-ticket") ??
    values.get("jira") ??
    env.CODEX_CODE_REVIEW_JIRA_TICKET ??
    env.JIRA_TICKET_INPUT ??
    "";
  const prLink =
    values.get("pr-link") ??
    values.get("pr") ??
    env.CODEX_CODE_REVIEW_PR_LINK ??
    env.PR_LINK_INPUT ??
    "";

  const phaseValue = (
    values.get("phase") ??
    env.CODEX_CODE_REVIEW_PHASE ??
    "review"
  )
    .trim()
    .toLowerCase();
  if (phaseValue !== "review" && phaseValue !== "apply") {
    throw new Error(
      `Invalid --phase value ${phaseValue}; expected review or apply`,
    );
  }

  if (phaseValue === "review" && !jiraTicket.trim()) {
    throw new Error("Missing required --jira-ticket argument");
  }
  if (phaseValue === "review" && !prLink.trim()) {
    throw new Error("Missing required --pr-link argument");
  }

  const outputDir =
    values.get("output-dir") ??
    env.CODEX_CODE_REVIEW_OUTPUT_DIR ??
    DEFAULT_OUTPUT_DIR;

  return {
    phase: phaseValue,
    jiraTicket: jiraTicket.trim(),
    prLink: prLink.trim(),
    outputDir,
    reviewDir:
      values.get("review-dir") ?? env.CODEX_CODE_REVIEW_REVIEW_DIR ?? outputDir,
    postPrComment: parseBoolean(
      values.get("post-pr-comment") ?? env.CODEX_CODE_REVIEW_POST_PR_COMMENT,
      false,
    ),
  };
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

function getRequiredEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  label = names.join(" or "),
): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`${label} is required`);
}

function getOptionalEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function githubApiHeaders(
  token: string | null,
  accept: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchGitHubJson<T>(
  url: string,
  token: string | null,
): Promise<T> {
  const response = await fetch(url, {
    headers: githubApiHeaders(token, "application/vnd.github+json"),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText} ${trimToChars(text, 500)}`,
    );
  }
  return JSON.parse(text) as T;
}

async function fetchGitHubText(
  url: string,
  token: string | null,
  accept: string,
): Promise<string> {
  const response = await fetch(url, {
    headers: githubApiHeaders(token, accept),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText} ${trimToChars(text, 500)}`,
    );
  }
  return text;
}

async function fetchPullRequestEvidence(
  prLink: string,
  token: string | null,
): Promise<{
  pr: GitHubPullRequestInfo;
  files: GitHubPullRequestFile[];
  diff: string;
}> {
  const parsed = parseGitHubPullRequestUrl(prLink);
  const repoPath = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const pullPath = `${repoPath}/pulls/${parsed.pullNumber}`;
  const apiBase =
    getOptionalEnv(process.env, ["GITHUB_API_BASE_URL"]) ?? GITHUB_API_BASE_URL;
  const pullUrl = `${apiBase}${pullPath}`;
  const payload = await fetchGitHubJson<Record<string, unknown>>(
    pullUrl,
    token,
  );
  const base = payload.base as Record<string, unknown> | undefined;
  const head = payload.head as Record<string, unknown> | undefined;
  const headRepo = head?.repo as Record<string, unknown> | undefined;
  const headRepoOwner = headRepo?.owner as Record<string, unknown> | undefined;
  const headOwner = String(headRepoOwner?.login ?? parsed.owner);
  const headRepoName = String(headRepo?.name ?? parsed.repo);

  const files: GitHubPullRequestFile[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageFiles = await fetchGitHubJson<Array<Record<string, unknown>>>(
      `${apiBase}${pullPath}/files?per_page=100&page=${page}`,
      token,
    );
    if (pageFiles.length === 0) {
      break;
    }
    for (const file of pageFiles) {
      files.push({
        filename: String(file.filename ?? ""),
        status: String(file.status ?? ""),
        additions: Number(file.additions ?? 0),
        deletions: Number(file.deletions ?? 0),
        changes: Number(file.changes ?? 0),
        patch: typeof file.patch === "string" ? file.patch : undefined,
      });
    }
    if (pageFiles.length < 100) {
      break;
    }
  }

  const diff = await fetchGitHubText(
    pullUrl,
    token,
    "application/vnd.github.v3.diff",
  );

  return {
    pr: {
      owner: parsed.owner,
      repo: parsed.repo,
      pullNumber: parsed.pullNumber,
      htmlUrl: String(payload.html_url ?? prLink),
      title: String(payload.title ?? ""),
      body: String(payload.body ?? ""),
      state: String(payload.state ?? "unknown"),
      draft: Boolean(payload.draft),
      baseRef: String(base?.ref ?? ""),
      baseSha: String(base?.sha ?? ""),
      headRef: String(head?.ref ?? ""),
      headSha: String(head?.sha ?? ""),
      headOwner,
      headRepo: headRepoName,
      headRepoFullName: String(
        headRepo?.full_name ?? `${headOwner}/${headRepoName}`,
      ),
      author: String(
        (payload.user as { login?: unknown } | undefined)?.login ?? "",
      ),
    },
    files: files.filter((file) => file.filename),
    diff,
  };
}

async function postPullRequestComment(input: {
  pr: GitHubPullRequestInfo;
  token: string | null;
  body: string;
}): Promise<void> {
  if (!input.token) {
    throw new Error(
      "GITHUB_REPO_TOKEN, GH_TOKEN, or GITHUB_TOKEN is required to post a PR comment",
    );
  }
  const apiBase =
    getOptionalEnv(process.env, ["GITHUB_API_BASE_URL"]) ?? GITHUB_API_BASE_URL;
  const url =
    `${apiBase}/repos/${encodeURIComponent(input.pr.owner)}/${encodeURIComponent(input.pr.repo)}` +
    `/issues/${input.pr.pullNumber}/comments`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...githubApiHeaders(input.token, "application/vnd.github+json"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: trimToChars(input.body, 62_000) }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `GitHub PR comment failed: ${response.status} ${response.statusText} ${trimToChars(text, 500)}`,
    );
  }
}

async function clonePullRequestHead(input: {
  pr: GitHubPullRequestInfo;
  token: string | null;
}): Promise<{ repoPath: string; cleanupPath: string }> {
  const cleanupPath = await mkdtemp(path.join(tmpdir(), "codex-code-review-"));
  const repoPath = path.join(cleanupPath, input.pr.repo);
  const cloneUrl = input.token
    ? `https://x-access-token:${encodeURIComponent(input.token)}@github.com/${input.pr.owner}/${input.pr.repo}.git`
    : `https://github.com/${input.pr.owner}/${input.pr.repo}.git`;

  await runGit(
    ["clone", "--filter=blob:none", "--no-checkout", cloneUrl, repoPath],
    {
      redact: input.token ? [input.token, encodeURIComponent(input.token)] : [],
    },
  );
  await runGit(
    [
      "-C",
      repoPath,
      "fetch",
      "--depth=1",
      "origin",
      `pull/${input.pr.pullNumber}/head:codex-code-review-pr`,
    ],
    {
      redact: input.token ? [input.token, encodeURIComponent(input.token)] : [],
    },
  );
  await runGit(
    ["-C", repoPath, "checkout", "--force", "codex-code-review-pr"],
    {
      redact: input.token ? [input.token, encodeURIComponent(input.token)] : [],
    },
  );

  return { repoPath, cleanupPath };
}

async function runGit(
  args: string[],
  options: { redact: string[] },
): Promise<void> {
  try {
    await execFileAsync("git", args, { maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    const raw =
      error instanceof Error
        ? `${error.message}\n${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`
        : String(error);
    throw new Error(redact(raw, options.redact));
  }
}

async function runGitCapture(
  args: string[],
  options: { redact: string[] },
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const raw =
      error instanceof Error
        ? `${error.message}\n${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`
        : String(error);
    throw new Error(redact(raw, options.redact));
  }
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce(
    (text, secret) => (secret ? text.split(secret).join("[REDACTED]") : text),
    value,
  );
}

export function resolvePrPushTarget(
  pr: GitHubPullRequestInfo,
  token: string,
): { remoteUrl: string; displayUrl: string; repository: string; ref: string } {
  if (!token.trim()) {
    throw new Error("A write-capable GitHub token is required to push fixes");
  }
  if (!pr.headOwner || !pr.headRepo || !pr.headRef) {
    throw new Error(
      "PR head repository metadata is missing; cannot determine where to push fixes",
    );
  }
  const repository = `${pr.headOwner}/${pr.headRepo}`;
  return {
    remoteUrl: `https://x-access-token:${encodeURIComponent(token)}@github.com/${repository}.git`,
    displayUrl: `https://github.com/${repository}.git`,
    repository,
    ref: pr.headRef,
  };
}

async function getWorkspaceChangedFiles(
  workspacePath: string,
): Promise<string[]> {
  const status = await runGitCapture(
    ["-C", workspacePath, "status", "--porcelain"],
    { redact: [] },
  );
  return parseGitPorcelainChangedFiles(status);
}

export function parseGitPorcelainChangedFiles(status: string): string[] {
  return status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const rawPath = line.slice(3);
      const renameTarget = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").pop()
        : rawPath;
      return normalizeRepoRelativePath(
        (renameTarget ?? rawPath).replace(/^"|"$/g, ""),
      );
    })
    .filter(Boolean);
}

async function getWorkspaceDiffStat(workspacePath: string): Promise<string> {
  return runGitCapture(["-C", workspacePath, "diff", "--stat"], {
    redact: [],
  });
}

async function commitAndPushFixes(input: {
  workspacePath: string;
  pr: GitHubPullRequestInfo;
  token: string;
  jiraTicket: string;
  shouldCommit: boolean;
}): Promise<FixCommitResult> {
  const changedFiles = await getWorkspaceChangedFiles(input.workspacePath);
  const diffStat = await getWorkspaceDiffStat(input.workspacePath);
  const pushTarget = resolvePrPushTarget(input.pr, input.token);

  if (changedFiles.length === 0 || !input.shouldCommit) {
    return {
      committed: false,
      pushed: false,
      commitSha: null,
      repository: pushTarget.repository,
      branch: pushTarget.ref,
      changedFiles: [],
      diffStat,
    };
  }

  const redactions = [input.token, encodeURIComponent(input.token)];
  await runGit(
    ["-C", input.workspacePath, "config", "user.name", "Codex Code Review"],
    { redact: redactions },
  );
  await runGit(
    ["-C", input.workspacePath, "config", "user.email", "devai@mhk.com"],
    { redact: redactions },
  );
  await runGit(["-C", input.workspacePath, "add", "-A"], {
    redact: redactions,
  });
  await runGit(
    [
      "-C",
      input.workspacePath,
      "commit",
      "-m",
      "Apply Codex code review fixes",
      "-m",
      `Jira: ${input.jiraTicket}`,
      "-m",
      `PR: ${input.pr.htmlUrl}`,
    ],
    { redact: redactions },
  );
  const commitSha = (
    await runGitCapture(["-C", input.workspacePath, "rev-parse", "HEAD"], {
      redact: redactions,
    })
  ).trim();
  await runGit(
    [
      "-C",
      input.workspacePath,
      "push",
      pushTarget.remoteUrl,
      `HEAD:${pushTarget.ref}`,
    ],
    { redact: redactions },
  );

  return {
    committed: true,
    pushed: true,
    commitSha,
    repository: pushTarget.repository,
    branch: pushTarget.ref,
    changedFiles,
    diffStat,
  };
}

export async function collectReviewRules(
  repoPath: string,
  changedFiles: string[],
): Promise<RuleDocument[]> {
  const candidates = new Set<string>();
  const rootFiles = [
    ".clinerules",
    "AGENTS.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
  ];
  for (const file of rootFiles) {
    candidates.add(file);
  }

  await addRuleDirectoryCandidates(repoPath, ".cursor/rules", candidates);
  await addRuleDirectoryCandidates(repoPath, ".claude/rules", candidates);
  await addRuleDirectoryCandidates(
    repoPath,
    ".github/instructions",
    candidates,
  );

  for (const changedFile of changedFiles) {
    const normalized = normalizeRepoRelativePath(changedFile);
    let dir = path.posix.dirname(normalized);
    while (dir && dir !== ".") {
      candidates.add(path.posix.join(dir, ".clinerules"));
      candidates.add(path.posix.join(dir, "AGENTS.md"));
      candidates.add(path.posix.join(dir, ".cursorrules"));
      dir = path.posix.dirname(dir);
    }
  }

  const docs: RuleDocument[] = [];
  let totalChars = 0;
  for (const relativePath of Array.from(candidates).sort(rulePathSort)) {
    const absolutePath = path.join(repoPath, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      continue;
    }
    if (totalChars >= MAX_RULES_CHARS) {
      break;
    }
    const content = await readFile(absolutePath, "utf8").catch(() => "");
    if (!content.trim()) {
      continue;
    }
    const remaining = MAX_RULES_CHARS - totalChars;
    const trimmed = trimToChars(content, remaining);
    docs.push({
      path: relativePath,
      content: trimmed,
      truncated: trimmed.length < content.length,
    });
    totalChars += trimmed.length;
  }

  return docs;
}

async function addRuleDirectoryCandidates(
  repoPath: string,
  relativeDir: string,
  candidates: Set<string>,
): Promise<void> {
  const absoluteDir = path.join(repoPath, relativeDir);
  if (!existsSync(absoluteDir)) {
    return;
  }
  await collectRuleFiles(absoluteDir, relativeDir, candidates, 50);
}

async function collectRuleFiles(
  absoluteDir: string,
  relativeDir: string,
  candidates: Set<string>,
  remaining: number,
): Promise<number> {
  if (remaining <= 0) {
    return 0;
  }
  const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(
    () => [],
  );
  let count = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (count >= remaining) {
      break;
    }
    const absolutePath = path.join(absoluteDir, entry.name);
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      count += await collectRuleFiles(
        absolutePath,
        relativePath,
        candidates,
        remaining - count,
      );
      continue;
    }
    if (
      entry.isFile() &&
      /\.(md|mdc|txt)$/i.test(entry.name) &&
      !entry.name.toLowerCase().includes("lock")
    ) {
      candidates.add(relativePath);
      count += 1;
    }
  }
  return count;
}

function rulePathSort(a: string, b: string): number {
  const aDepth = a.split("/").length;
  const bDepth = b.split("/").length;
  if (aDepth !== bDepth) {
    return aDepth - bDepth;
  }
  return a.localeCompare(b);
}

export async function collectChangedFileSnapshots(
  repoPath: string,
  files: GitHubPullRequestFile[],
): Promise<ChangedFileSnapshot[]> {
  const snapshots: ChangedFileSnapshot[] = [];
  let totalChars = 0;
  for (const file of files) {
    if (file.status === "removed" || totalChars >= MAX_FILE_CONTENT_CHARS) {
      continue;
    }
    const relativePath = normalizeRepoRelativePath(file.filename);
    const absolutePath = path.join(repoPath, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > 200_000) {
      continue;
    }
    const buffer = await readFile(absolutePath);
    if (buffer.includes(0)) {
      continue;
    }
    const raw = buffer.toString("utf8");
    const remaining = MAX_FILE_CONTENT_CHARS - totalChars;
    const content = trimToChars(raw, remaining);
    snapshots.push({
      path: relativePath,
      status: file.status,
      content,
      truncated: content.length < raw.length,
    });
    totalChars += content.length;
  }
  return snapshots;
}

function normalizeRepoRelativePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function trimToChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 80))}\n\n[TRUNCATED: ${value.length - maxChars} chars omitted]`;
}

function formatJiraTicket(ticket: JiraTicketData): string {
  const issue = ticket.issue;
  const fields = issue.fields;
  const comments = ticket.comments.slice(-20);
  const textAttachments = ticket.textAttachments.slice(0, 5);
  const raw = [
    `Key: ${issue.key}`,
    `Summary: ${fields.summary ?? ""}`,
    `Issue type: ${fields.issuetype?.name ?? ""}`,
    `Status: ${fields.status?.name ?? ""}`,
    `Priority: ${fields.priority?.name ?? ""}`,
    `Labels: ${(fields.labels ?? []).join(", ")}`,
    `Components: ${(fields.components ?? [])
      .map((c) => c.name)
      .filter(Boolean)
      .join(", ")}`,
    `Fix versions: ${(fields.fixVersions ?? [])
      .map((v) => v.name)
      .filter(Boolean)
      .join(", ")}`,
    `Assignee: ${fields.assignee?.displayName ?? ""}`,
    `Reporter: ${fields.reporter?.displayName ?? ""}`,
    fields.parent?.key
      ? `Parent: ${fields.parent.key} - ${fields.parent.fields?.summary ?? ""}`
      : "",
    "",
    "Description:",
    ticket.descriptionMarkdown || "(empty)",
    "",
    "Recent comments:",
    ...comments.map((comment) =>
      [
        `Comment ${comment.id} by ${comment.author ?? "unknown"} at ${comment.created}:`,
        comment.bodyMarkdown || "(empty)",
      ].join("\n"),
    ),
    "",
    "Text attachments:",
    ...textAttachments.map((attachment) =>
      [
        `Attachment: ${attachment.filename} (${attachment.size} bytes)`,
        trimToChars(attachment.content, 12_000),
      ].join("\n"),
    ),
  ]
    .filter((part) => part !== "")
    .join("\n");

  return trimToChars(raw, MAX_TICKET_CHARS);
}

function buildPrompt(input: {
  jiraTicket: string;
  ticket: JiraTicketData;
  pr: GitHubPullRequestInfo;
  files: GitHubPullRequestFile[];
  diff: string;
  rules: RuleDocument[];
  snapshots: ChangedFileSnapshot[];
}): string {
  const changedFileSummary = input.files
    .map(
      (file) =>
        `- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions}, ${file.changes} changes)`,
    )
    .join("\n");
  const rulesSection =
    input.rules.length > 0
      ? input.rules
          .map((rule) =>
            [
              `### ${rule.path}${rule.truncated ? " (truncated)" : ""}`,
              "```text",
              rule.content,
              "```",
            ].join("\n"),
          )
          .join("\n\n")
      : "(No rule files were found in the PR repository checkout.)";
  const snapshotsSection =
    input.snapshots.length > 0
      ? input.snapshots
          .map((snapshot) =>
            [
              `### ${snapshot.path} (${snapshot.status}${snapshot.truncated ? ", truncated" : ""})`,
              "```text",
              snapshot.content,
              "```",
            ].join("\n"),
          )
          .join("\n\n")
      : "(No changed file snapshots were included; rely on the diff.)";

  return [
    "You are reviewing a pull request against the Jira ticket that requested it.",
    "The goal is to decide whether the PR satisfies the ticket and whether it violates repository rules.",
    "",
    "Review requirements:",
    "- Read the Jira ticket as the source request.",
    "- Treat the repository workspace available to your tools as the checked-out PR head branch.",
    "- Compare the PR title, body, changed files, diff, and changed file snapshots against the ticket ask.",
    "- Use repository tools to inspect surrounding implementation, existing tests, and related code paths beyond the diff when needed.",
    "- Identify missing requirements, incorrect implementations, risky scope expansion, and insufficient tests.",
    "- Apply repository rules exactly. Use root rules for all files and nested rules for matching paths.",
    "- Cite concrete file paths, line references when available, and the specific rule path when raising a rule violation.",
    "- Do not approve when material Jira requirements are missing or cannot be verified from the available evidence.",
    "- Do not invent requirements or code that is not present in the evidence.",
    "",
    "Jira ticket evidence:",
    "```text",
    formatJiraTicket(input.ticket),
    "```",
    "",
    "Pull request metadata:",
    "```text",
    `PR: ${input.pr.htmlUrl}`,
    `Repository: ${input.pr.owner}/${input.pr.repo}`,
    `Number: ${input.pr.pullNumber}`,
    `Title: ${input.pr.title}`,
    `State: ${input.pr.state}`,
    `Draft: ${input.pr.draft}`,
    `Author: ${input.pr.author}`,
    `Base: ${input.pr.baseRef} @ ${input.pr.baseSha}`,
    `Head: ${input.pr.headRef} @ ${input.pr.headSha}`,
    `Head repository: ${input.pr.headRepoFullName}`,
    "",
    "Body:",
    input.pr.body || "(empty)",
    "```",
    "",
    "Changed files:",
    "```text",
    changedFileSummary || "(none)",
    "```",
    "",
    "Repository rules:",
    rulesSection,
    "",
    "Unified diff:",
    "```diff",
    trimToChars(input.diff, MAX_DIFF_CHARS),
    "```",
    "",
    "Changed file snapshots:",
    snapshotsSection,
  ].join("\n");
}

async function callOpenAiReview(input: {
  prompt: string;
  model: string;
  reasoningEffort: string;
  workspacePath: string;
}): Promise<{
  review: CodexCodeReview;
  usage: CodexCodeReviewUsage | null;
}> {
  const promptBytes = Buffer.byteLength(input.prompt, "utf8");
  if (promptBytes > MAX_PROMPT_BYTES) {
    throw new Error(
      `Codex-Code-Review prompt is too large: ${promptBytes} bytes > ${MAX_PROMPT_BYTES} bytes`,
    );
  }

  const result = await runOpenAiAgent({
    taskId: `codex-code-review-${Date.now()}`,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    workspacePath: input.workspacePath,
    systemPrompt:
      "You are Codex-Code-Review, a rigorous senior engineer reviewing a PR against Jira requirements and repository rules. Use the read-only repository tools to inspect related files, existing patterns, tests, and rule files in the checked-out PR workspace before returning JSON.",
    userPrompt: input.prompt,
    outputSchema: CODEX_CODE_REVIEW_OUTPUT_SCHEMA,
    schemaName: "codex_code_review",
  });

  if (!result.success) {
    throw new Error(result.error || "Codex-Code-Review OpenAI run failed");
  }

  const review = result.structuredOutput
    ? CodexCodeReviewSchema.parse(result.structuredOutput)
    : CodexCodeReviewSchema.parse(parseJsonText(result.output));
  return {
    review,
    usage: buildCodeReviewUsage(input.model, result.metrics.tokensUsed),
  };
}

export async function callOpenAiFixAgent(input: {
  jiraTicket: string;
  ticket: JiraTicketData;
  pr: GitHubPullRequestInfo;
  files: GitHubPullRequestFile[];
  diff: string;
  rules: RuleDocument[];
  review: CodexCodeReview;
  model: string;
  reasoningEffort: string;
  workspacePath: string;
}): Promise<{
  result: CodexCodeReviewFixResult;
  usage: CodexCodeReviewUsage | null;
}> {
  const prompt = buildFixPrompt(input);
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > MAX_PROMPT_BYTES) {
    throw new Error(
      `Codex-Code-Review fix prompt is too large: ${promptBytes} bytes > ${MAX_PROMPT_BYTES} bytes`,
    );
  }

  const client = new OpenAI({
    apiKey: getRequiredEnv(process.env, ["OPENAI_API_KEY"]),
    baseURL: process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL,
  });
  const repoTools = createWritableRepoTools(
    input.workspacePath,
    input.pr.baseSha,
  );
  const maxToolIterations = getMaxFixToolIterations();
  const options = {
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    systemPrompt:
      "You are Codex-Code-Review-Fixer, a senior engineer applying only the minimal code changes required by a prior PR review. Use replace_text for localized edits and restore_from_base for out-of-scope PR changes. Use write_file only when creating a new file or replacing a complete small file. Do not make unrelated refactors, formatting churn, generated-file updates, dependency changes, or secret edits unless the review explicitly requires them.",
    userPrompt: prompt,
    outputSchema: CODEX_CODE_REVIEW_FIX_OUTPUT_SCHEMA,
    schemaName: "codex_code_review_fix",
  };
  const conversationItems: OpenAiResponseItem[] = [
    buildUserPromptInputItem(prompt),
  ];
  const tokensUsed = {
    input: 0,
    output: 0,
    cachedInput: 0,
    cacheWrite: 0,
  };
  let { response, includeEncryptedReasoning } = await createFixInitialResponse(
    client,
    options,
    repoTools.tools,
  );

  let toolIteration = 0;
  while (true) {
    const responseUsage = extractOpenAiResponseUsage(response);
    if (responseUsage) {
      tokensUsed.input += responseUsage.input;
      tokensUsed.output += responseUsage.output;
      tokensUsed.cachedInput += responseUsage.cachedInput;
      tokensUsed.cacheWrite += responseUsage.cacheWrite;
    }

    const continuationItems = filterFixContinuationItems(
      extractOutputItems(response),
    );
    if (continuationItems.length > 0) {
      conversationItems.push(...continuationItems);
    }

    const functionCalls = extractFunctionCalls(response);
    if (functionCalls.length === 0) {
      const rawOutput = extractResponseText(response);
      return {
        result: CodexCodeReviewFixResultSchema.parse(parseJsonText(rawOutput)),
        usage: buildCodeReviewUsage(input.model, tokensUsed),
      };
    }

    if (toolIteration >= maxToolIterations) {
      throw new Error(
        "Codex-Code-Review fix agent requested another tool after its forced final response",
      );
    }

    toolIteration += 1;
    console.log(
      `Codex-Code-Review fix tool turn ${toolIteration}/${maxToolIterations}: ${functionCalls.map((call) => call.name).join(", ")}`,
    );
    const toolOutputs: OpenAiResponseItem[] = [];
    for (const call of functionCalls) {
      let output: unknown;
      try {
        output = await repoTools.execute(call);
      } catch (error) {
        output = buildToolErrorOutput(error);
      }
      toolOutputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output: typeof output === "string" ? output : JSON.stringify(output),
      });
    }
    conversationItems.push(...toolOutputs);

    if (toolIteration >= maxToolIterations) {
      console.warn(
        `Codex-Code-Review fix agent reached ${maxToolIterations} tool turns; requesting a final result without tools`,
      );
      response = await createFixFinalResponse(
        client,
        options,
        conversationItems,
        includeEncryptedReasoning,
      );
      continue;
    }

    try {
      response = await client.responses.create(
        buildFixContinuationRequest(
          options,
          conversationItems,
          repoTools.tools,
          includeEncryptedReasoning,
        ) as never,
      );
    } catch (error) {
      if (
        !includeEncryptedReasoning ||
        !isEncryptedReasoningIncludeError(error)
      ) {
        throw error;
      }
      includeEncryptedReasoning = false;
      response = await client.responses.create(
        buildFixContinuationRequest(
          options,
          conversationItems,
          repoTools.tools,
          false,
        ) as never,
      );
    }
  }
}

function buildFixPrompt(input: {
  jiraTicket: string;
  ticket: JiraTicketData;
  pr: GitHubPullRequestInfo;
  files: GitHubPullRequestFile[];
  diff: string;
  rules: RuleDocument[];
  review: CodexCodeReview;
}): string {
  const rulesSection =
    input.rules.length > 0
      ? input.rules
          .map((rule) =>
            [
              `### ${rule.path}${rule.truncated ? " (truncated)" : ""}`,
              "```text",
              rule.content,
              "```",
            ].join("\n"),
          )
          .join("\n\n")
      : "(No rule files were found in the PR repository checkout.)";

  return [
    "You are applying fixes to the checked-out PR head branch after a Codex-Code-Review run.",
    "",
    "Fix requirements:",
    "- Apply only changes needed to satisfy the Jira ticket and the review findings.",
    "- Keep the patch minimal and localized to the PR's intended scope.",
    "- Preserve repository rules and existing style.",
    "- Use repository tools to inspect surrounding code before writing.",
    "- Do not edit secrets, generated build output, dependency lockfiles, or unrelated files unless the review findings explicitly require it.",
    "- If a finding is ambiguous or unsafe to fix automatically, leave it unchanged and list it in residualRisks.",
    "- Return JSON only after all intended file writes are complete.",
    "",
    "Jira ticket evidence:",
    "```text",
    formatJiraTicket(input.ticket),
    "```",
    "",
    "Pull request metadata:",
    "```text",
    `PR: ${input.pr.htmlUrl}`,
    `Repository: ${input.pr.owner}/${input.pr.repo}`,
    `Head repository: ${input.pr.headRepoFullName}`,
    `Number: ${input.pr.pullNumber}`,
    `Title: ${input.pr.title}`,
    `Base: ${input.pr.baseRef} @ ${input.pr.baseSha}`,
    `Head: ${input.pr.headRef} @ ${input.pr.headSha}`,
    "```",
    "",
    "Prior review JSON:",
    "```json",
    JSON.stringify(input.review, null, 2),
    "```",
    "",
    "Repository rules:",
    rulesSection,
    "",
    "Original PR diff:",
    "```diff",
    trimToChars(input.diff, MAX_DIFF_CHARS),
    "```",
  ].join("\n");
}

interface OpenAiResponseItem {
  [key: string]: unknown;
}

interface FixAgentOptions {
  model: string;
  reasoningEffort: string;
  systemPrompt: string;
  userPrompt: string;
  outputSchema: Record<string, unknown>;
  schemaName: string;
}

interface WritableRepoToolSet {
  tools: Array<Record<string, unknown>>;
  execute: (call: OpenAiFunctionCall) => Promise<unknown>;
}

export function getMaxFixToolIterations(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = [
    [
      "CODEX_CODE_REVIEW_MAX_FIX_TOOL_ITERATIONS",
      env.CODEX_CODE_REVIEW_MAX_FIX_TOOL_ITERATIONS?.trim(),
    ],
    ["OPENAI_MAX_TOOL_ITERATIONS", env.OPENAI_MAX_TOOL_ITERATIONS?.trim()],
  ].find(([, value]) => Boolean(value));
  if (!configured) {
    return MAX_FIX_TOOL_ITERATIONS;
  }
  const [variableName, rawValue] = configured;
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(
      `${variableName} must be a positive integer when set; received ${rawValue}`,
    );
  }
  return parsedValue;
}

export function createWritableRepoTools(
  workspacePath: string,
  baseSha: string,
): WritableRepoToolSet {
  const rootPath = path.resolve(workspacePath);
  assertGitCommitSha(baseSha);
  const tools: Array<Record<string, unknown>> = [
    {
      type: "function",
      name: "list_directory",
      description:
        "List files and directories under the workspace. Use this before reading unfamiliar areas.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          maxDepth: { type: "integer", minimum: 0, maximum: 6 },
        },
      },
    },
    {
      type: "function",
      name: "glob_search",
      description:
        "Find files and directories matching a glob pattern relative to the workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["pattern"],
      },
    },
    {
      type: "function",
      name: "grep_search",
      description:
        "Search text in repository files and return matching paths and line numbers.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          filePattern: { type: "string" },
          caseSensitive: { type: "boolean" },
          maxResults: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "read_file",
      description:
        "Read a UTF-8 text file from the workspace, optionally limited to a line range.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["path"],
      },
    },
    {
      type: "function",
      name: "write_file",
      description:
        "Overwrite a UTF-8 text file under the workspace. Use only for minimal, review-required source changes.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    {
      type: "function",
      name: "replace_text",
      description:
        "Replace one exact text occurrence in an existing UTF-8 file. Include enough surrounding text in oldText to make the match unique.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
      },
    },
    {
      type: "function",
      name: "restore_from_base",
      description:
        "Restore a file or directory exactly from the reviewed PR base commit. Use this to remove out-of-scope PR modifications or deletions.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
    {
      type: "function",
      name: "git_status",
      description: "Return the current workspace git status.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      type: "function",
      name: "git_diff",
      description:
        "Return the current uncommitted workspace diff, optionally limited to one path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
        },
      },
    },
  ];

  return {
    tools,
    execute: async (call) => {
      const args = call.arguments
        ? (JSON.parse(call.arguments) as Record<string, unknown>)
        : {};
      switch (call.name) {
        case "list_directory":
          return toolListDirectory(rootPath, args);
        case "glob_search":
          return toolGlobSearch(rootPath, args);
        case "grep_search":
          return toolGrepSearch(rootPath, args);
        case "read_file":
          return toolReadFile(rootPath, args);
        case "write_file":
          return toolWriteFile(rootPath, args);
        case "replace_text":
          return toolReplaceText(rootPath, args);
        case "restore_from_base":
          return toolRestoreFromBase(rootPath, baseSha, args);
        case "git_status":
          return toolGitStatus(rootPath);
        case "git_diff":
          return toolGitDiff(rootPath, args);
        default:
          throw new Error(`Unknown Codex-Code-Review fix tool: ${call.name}`);
      }
    },
  };
}

const SKIPPED_TOOL_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".turbo",
]);

interface ToolDirectoryEntry {
  path: string;
  type: "file" | "directory";
}

function normalizeToolRelativePath(inputPath = "."): string {
  const normalized = inputPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : ".";
}

function resolveToolWorkspacePath(
  rootPath: string,
  relativePath = ".",
): { absolutePath: string; normalizedPath: string } {
  const normalizedPath = normalizeToolRelativePath(relativePath);
  const resolvedRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(resolvedRoot, normalizedPath);
  if (
    absolutePath !== resolvedRoot &&
    !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Path resolves outside the workspace: ${relativePath}`);
  }
  return { absolutePath, normalizedPath };
}

function assertWritableToolPath(normalizedPath: string): void {
  if (!normalizedPath || normalizedPath === ".") {
    throw new Error("write_file requires a file path");
  }
  const segments = normalizedPath.split("/");
  for (const segment of segments) {
    if (SKIPPED_TOOL_DIRECTORIES.has(segment)) {
      throw new Error(`Refusing to write blocked path: ${normalizedPath}`);
    }
  }
  if (/^\.env($|\.)/.test(path.posix.basename(normalizedPath))) {
    throw new Error(`Refusing to write environment file: ${normalizedPath}`);
  }
}

function assertGitCommitSha(value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`Invalid reviewed base commit SHA: ${value}`);
  }
}

async function collectToolDirectoryEntries(
  currentPath: string,
  maxDepth: number,
  results: ToolDirectoryEntry[],
  prefix = ".",
): Promise<void> {
  if (results.length >= 200) {
    return;
  }
  const dirents = await readdir(currentPath, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    if (results.length >= 200) {
      return;
    }
    if (dirent.isDirectory() && SKIPPED_TOOL_DIRECTORIES.has(dirent.name)) {
      continue;
    }
    const relativePath =
      prefix === "." ? dirent.name : `${prefix}/${dirent.name}`;
    results.push({
      path: relativePath,
      type: dirent.isDirectory() ? "directory" : "file",
    });
    if (dirent.isDirectory() && maxDepth > 0) {
      await collectToolDirectoryEntries(
        path.join(currentPath, dirent.name),
        maxDepth - 1,
        results,
        relativePath,
      );
    }
  }
}

async function toolListDirectory(
  rootPath: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const relativePath = typeof args.path === "string" ? args.path : ".";
  const maxDepth =
    typeof args.maxDepth === "number" && args.maxDepth >= 0
      ? Math.min(Math.floor(args.maxDepth), 6)
      : 2;
  const { absolutePath, normalizedPath } = resolveToolWorkspacePath(
    rootPath,
    relativePath,
  );
  const info = await stat(absolutePath);
  if (!info.isDirectory()) {
    throw new Error(`Not a directory: ${relativePath}`);
  }
  const entries: ToolDirectoryEntry[] = [];
  await collectToolDirectoryEntries(
    absolutePath,
    maxDepth,
    entries,
    normalizedPath === "." ? "." : normalizedPath,
  );
  return {
    path: normalizedPath,
    maxDepth,
    truncated: entries.length >= 200,
    entries,
  };
}

async function toolGlobSearch(
  rootPath: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) {
    throw new Error("glob_search requires a pattern");
  }
  const cwd = typeof args.cwd === "string" ? args.cwd : ".";
  const { absolutePath: resolvedCwd, normalizedPath } =
    resolveToolWorkspacePath(rootPath, cwd);
  const matches = await glob(pattern, {
    cwd: resolvedCwd,
    nodir: false,
    dot: true,
    absolute: false,
    withFileTypes: false,
    ignore: [
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/target/**",
      "**/.next/**",
      "**/.turbo/**",
    ],
  });
  const formatted = await Promise.all(
    matches.slice(0, 200).map(async (entry) => {
      const { absolutePath } = resolveToolWorkspacePath(resolvedCwd, entry);
      const info = await stat(absolutePath);
      return {
        path: normalizeToolRelativePath(path.posix.join(normalizedPath, entry)),
        type: info.isDirectory() ? "directory" : "file",
      };
    }),
  );
  return {
    pattern,
    cwd: normalizedPath,
    truncated: matches.length > 200,
    matches: formatted,
  };
}

async function toolGrepSearch(
  rootPath: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query) {
    throw new Error("grep_search requires a query");
  }
  const relativePath = typeof args.path === "string" ? args.path : ".";
  const filePattern =
    typeof args.filePattern === "string" ? args.filePattern : "**/*";
  const caseSensitive = args.caseSensitive === true;
  const maxResults =
    typeof args.maxResults === "number" && args.maxResults > 0
      ? Math.min(Math.floor(args.maxResults), 100)
      : 20;
  const { absolutePath: basePath, normalizedPath } = resolveToolWorkspacePath(
    rootPath,
    relativePath,
  );
  const matches = await glob(filePattern, {
    cwd: basePath,
    nodir: true,
    dot: true,
    absolute: false,
    ignore: [
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/target/**",
      "**/.next/**",
      "**/.turbo/**",
    ],
  });
  const needle = caseSensitive ? query : query.toLowerCase();
  const results: Array<{ path: string; line: number; excerpt: string }> = [];
  for (const match of matches) {
    if (results.length >= maxResults) {
      break;
    }
    const { absolutePath } = resolveToolWorkspacePath(basePath, match);
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch {
      continue;
    }
    if (!isProbablyText(buffer)) {
      continue;
    }
    const content = buffer.toString("utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const haystack = caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(needle)) {
        continue;
      }
      results.push({
        path: normalizeToolRelativePath(path.posix.join(normalizedPath, match)),
        line: index + 1,
        excerpt: line.slice(0, 400),
      });
      if (results.length >= maxResults) {
        break;
      }
    }
  }
  return {
    query,
    path: normalizedPath,
    filePattern,
    truncated: results.length >= maxResults,
    matches: results,
  };
}

async function toolReadFile(
  rootPath: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const relativePath = typeof args.path === "string" ? args.path : "";
  if (!relativePath) {
    throw new Error("read_file requires a path");
  }
  const startLine =
    typeof args.startLine === "number" && args.startLine > 0
      ? Math.floor(args.startLine)
      : 1;
  const endLine =
    typeof args.endLine === "number" && args.endLine >= startLine
      ? Math.floor(args.endLine)
      : startLine + 199;
  const { absolutePath, normalizedPath } = resolveToolWorkspacePath(
    rootPath,
    relativePath,
  );
  const buffer = await readFile(absolutePath);
  if (!isProbablyText(buffer)) {
    throw new Error(`File appears to be binary: ${relativePath}`);
  }
  const rawContent = buffer.toString("utf8");
  const lines = rawContent.split(/\r?\n/);
  const selectedLines = lines.slice(startLine - 1, endLine);
  const numberedContent = selectedLines
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");
  const truncated = truncateBytes(numberedContent, MAX_FIX_TOOL_TEXT_BYTES);
  return {
    path: normalizedPath,
    startLine,
    endLine: Math.min(endLine, lines.length),
    totalLines: lines.length,
    truncated: truncated.truncated,
    content: truncated.content,
  };
}

async function toolWriteFile(
  rootPath: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const relativePath = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : null;
  if (!relativePath || content === null) {
    throw new Error("write_file requires path and content");
  }
  const { absolutePath, normalizedPath } = resolveToolWorkspacePath(
    rootPath,
    relativePath,
  );
  assertWritableToolPath(normalizedPath);
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_WRITE_FILE_BYTES) {
    throw new Error(
      `Refusing to write ${normalizedPath}; ${byteLength} bytes exceeds ${MAX_WRITE_FILE_BYTES}`,
    );
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return {
    ok: true,
    path: normalizedPath,
    bytes: byteLength,
  };
}

async function toolReplaceText(
  rootPath: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const relativePath = typeof args.path === "string" ? args.path : "";
  const oldText = typeof args.oldText === "string" ? args.oldText : "";
  const newText = typeof args.newText === "string" ? args.newText : null;
  if (!relativePath || !oldText || newText === null) {
    throw new Error(
      "replace_text requires path, non-empty oldText, and newText",
    );
  }
  const { absolutePath, normalizedPath } = resolveToolWorkspacePath(
    rootPath,
    relativePath,
  );
  assertWritableToolPath(normalizedPath);
  const buffer = await readFile(absolutePath);
  if (!isProbablyText(buffer)) {
    throw new Error(`File appears to be binary: ${relativePath}`);
  }
  const content = buffer.toString("utf8");
  const matchCount = content.split(oldText).length - 1;
  if (matchCount !== 1) {
    throw new Error(
      `replace_text expected exactly one match in ${normalizedPath}; found ${matchCount}`,
    );
  }
  const updatedContent = content.replace(oldText, newText);
  const byteLength = Buffer.byteLength(updatedContent, "utf8");
  if (byteLength > MAX_WRITE_FILE_BYTES) {
    throw new Error(
      `Refusing to write ${normalizedPath}; ${byteLength} bytes exceeds ${MAX_WRITE_FILE_BYTES}`,
    );
  }
  await writeFile(absolutePath, updatedContent, "utf8");
  return {
    ok: true,
    path: normalizedPath,
    replacements: 1,
    bytes: byteLength,
  };
}

async function toolRestoreFromBase(
  rootPath: string,
  baseSha: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const relativePath = typeof args.path === "string" ? args.path : "";
  if (!relativePath) {
    throw new Error("restore_from_base requires a path");
  }
  const { normalizedPath } = resolveToolWorkspacePath(rootPath, relativePath);
  assertWritableToolPath(normalizedPath);
  await runGit(["-C", rootPath, "cat-file", "-e", `${baseSha}^{commit}`], {
    redact: [],
  });
  await runGit(
    [
      "-C",
      rootPath,
      "restore",
      `--source=${baseSha}`,
      "--worktree",
      "--",
      normalizedPath,
    ],
    { redact: [] },
  );
  return {
    ok: true,
    path: normalizedPath,
    source: "reviewed-pr-base",
  };
}

async function toolGitStatus(rootPath: string): Promise<unknown> {
  const status = await runGitCapture(
    ["-C", rootPath, "status", "--porcelain"],
    { redact: [] },
  );
  return { status };
}

async function toolGitDiff(
  rootPath: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const relativePath =
    typeof args.path === "string" && args.path.trim()
      ? normalizeToolRelativePath(args.path)
      : null;
  if (relativePath) {
    resolveToolWorkspacePath(rootPath, relativePath);
  }
  const gitArgs = ["-C", rootPath, "diff", "--no-ext-diff"];
  if (relativePath) {
    gitArgs.push("--", relativePath);
  }
  const diff = await runGitCapture(gitArgs, { redact: [] });
  const truncated = truncateBytes(diff, MAX_FIX_TOOL_TEXT_BYTES);
  return {
    path: relativePath,
    truncated: truncated.truncated,
    diff: truncated.content,
  };
}

function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !sample.includes(0);
}

function truncateBytes(
  value: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= maxBytes) {
    return { content: value, truncated: false };
  }
  return {
    content: Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function buildUserPromptInputItem(userPrompt: string): OpenAiResponseItem {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: userPrompt,
      },
    ],
  };
}

function buildFixTextFormat(options: FixAgentOptions): Record<string, unknown> {
  return {
    format: {
      type: "json_schema",
      name: options.schemaName,
      strict: true,
      schema: options.outputSchema,
    },
  };
}

function buildFixReasoningConfig(
  options: FixAgentOptions,
): Record<string, unknown> | undefined {
  return options.reasoningEffort
    ? { effort: options.reasoningEffort }
    : undefined;
}

function buildFixInitialRequest(
  options: FixAgentOptions,
  tools: Array<Record<string, unknown>>,
  includeEncryptedReasoning: boolean,
): Record<string, unknown> {
  return {
    model: options.model,
    instructions: options.systemPrompt,
    input: options.userPrompt,
    reasoning: buildFixReasoningConfig(options),
    ...(includeEncryptedReasoning
      ? { include: ["reasoning.encrypted_content"] }
      : {}),
    tools,
    text: buildFixTextFormat(options),
  };
}

function buildFixContinuationRequest(
  options: FixAgentOptions,
  transcriptItems: OpenAiResponseItem[],
  tools: Array<Record<string, unknown>>,
  includeEncryptedReasoning: boolean,
): Record<string, unknown> {
  return {
    model: options.model,
    instructions: options.systemPrompt,
    input: [...transcriptItems],
    reasoning: buildFixReasoningConfig(options),
    ...(includeEncryptedReasoning
      ? { include: ["reasoning.encrypted_content"] }
      : {}),
    tools,
    text: buildFixTextFormat(options),
  };
}

function buildFixFinalizationRequest(
  options: FixAgentOptions,
  transcriptItems: OpenAiResponseItem[],
  includeEncryptedReasoning: boolean,
): Record<string, unknown> {
  return {
    model: options.model,
    instructions: options.systemPrompt,
    input: [
      ...transcriptItems,
      buildUserPromptInputItem(FIX_AGENT_FINALIZATION_PROMPT),
    ],
    reasoning: buildFixReasoningConfig(options),
    ...(includeEncryptedReasoning
      ? { include: ["reasoning.encrypted_content"] }
      : {}),
    text: buildFixTextFormat(options),
  };
}

async function createFixInitialResponse(
  client: OpenAI,
  options: FixAgentOptions,
  tools: Array<Record<string, unknown>>,
): Promise<{ response: unknown; includeEncryptedReasoning: boolean }> {
  try {
    const response = await client.responses.create(
      buildFixInitialRequest(options, tools, true) as never,
    );
    return { response, includeEncryptedReasoning: true };
  } catch (error) {
    if (!isEncryptedReasoningIncludeError(error)) {
      throw error;
    }
    const response = await client.responses.create(
      buildFixInitialRequest(options, tools, false) as never,
    );
    return { response, includeEncryptedReasoning: false };
  }
}

async function createFixFinalResponse(
  client: OpenAI,
  options: FixAgentOptions,
  transcriptItems: OpenAiResponseItem[],
  includeEncryptedReasoning: boolean,
): Promise<unknown> {
  try {
    return await client.responses.create(
      buildFixFinalizationRequest(
        options,
        transcriptItems,
        includeEncryptedReasoning,
      ) as never,
    );
  } catch (error) {
    if (
      !includeEncryptedReasoning ||
      !isEncryptedReasoningIncludeError(error)
    ) {
      throw error;
    }
    return client.responses.create(
      buildFixFinalizationRequest(options, transcriptItems, false) as never,
    );
  }
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new Error("OpenAI fix agent returned a non-object payload");
  }
  const maybePayload = payload as {
    output_text?: unknown;
    output?: Array<{
      type?: string;
      content?: Array<{
        type?: string;
        text?: string | { value?: string };
      }>;
      text?: string | { value?: string };
    }>;
  };
  if (
    typeof maybePayload.output_text === "string" &&
    maybePayload.output_text.trim()
  ) {
    return maybePayload.output_text;
  }
  const parts: string[] = [];
  for (const outputItem of maybePayload.output ?? []) {
    if (typeof outputItem.text === "string" && outputItem.text.trim()) {
      parts.push(outputItem.text);
    } else if (
      outputItem.text &&
      typeof outputItem.text === "object" &&
      typeof outputItem.text.value === "string" &&
      outputItem.text.value.trim()
    ) {
      parts.push(outputItem.text.value);
    }
    for (const contentItem of outputItem.content ?? []) {
      if (typeof contentItem.text === "string" && contentItem.text.trim()) {
        parts.push(contentItem.text);
        continue;
      }
      if (
        contentItem.text &&
        typeof contentItem.text === "object" &&
        typeof contentItem.text.value === "string" &&
        contentItem.text.value.trim()
      ) {
        parts.push(contentItem.text.value);
      }
    }
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  throw new Error("OpenAI fix agent response did not contain output text");
}

function extractOpenAiResponseUsage(payload: unknown):
  | {
      input: number;
      output: number;
      cachedInput: number;
      cacheWrite: number;
    }
  | undefined {
  if (!payload || typeof payload !== "object" || !("usage" in payload)) {
    return undefined;
  }
  const usage = (payload as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const details = usage.input_tokens_details as
    | { cached_tokens?: unknown; cache_write_tokens?: unknown }
    | undefined;
  const input =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : 0;
  const output =
    typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : 0;
  const cachedInput =
    details && typeof details.cached_tokens === "number"
      ? details.cached_tokens
      : 0;
  const cacheWrite =
    details && typeof details.cache_write_tokens === "number"
      ? details.cache_write_tokens
      : 0;
  return input > 0 || output > 0 || cachedInput > 0 || cacheWrite > 0
    ? { input, output, cachedInput, cacheWrite }
    : undefined;
}

function buildCodeReviewUsage(
  model: string,
  tokensUsed:
    | {
        input: number;
        output: number;
        cachedInput?: number;
        cacheWrite?: number;
      }
    | undefined,
): CodexCodeReviewUsage | null {
  if (
    !tokensUsed ||
    (tokensUsed.input === 0 &&
      tokensUsed.output === 0 &&
      (tokensUsed.cachedInput ?? 0) === 0 &&
      (tokensUsed.cacheWrite ?? 0) === 0)
  ) {
    return null;
  }
  return {
    inputTokens: tokensUsed.input,
    outputTokens: tokensUsed.output,
    cachedInputTokens: tokensUsed.cachedInput ?? 0,
    cacheWriteTokens: tokensUsed.cacheWrite ?? 0,
    totalTokens: tokensUsed.input + tokensUsed.output,
    estimatedCostUsd: calculateUsageCostUsd("openai", model, tokensUsed),
  };
}

function extractOutputItems(payload: unknown): OpenAiResponseItem[] {
  if (!payload || typeof payload !== "object" || !("output" in payload)) {
    return [];
  }
  const output = (payload as { output?: Array<Record<string, unknown>> })
    .output;
  if (!Array.isArray(output)) {
    return [];
  }
  return output.filter((item) => item && typeof item === "object");
}

function extractFunctionCalls(payload: unknown): OpenAiFunctionCall[] {
  return extractOutputItems(payload)
    .filter((item) => item?.type === "function_call")
    .map((item) => ({
      callId: typeof item.call_id === "string" ? item.call_id : "",
      name: typeof item.name === "string" ? item.name : "",
      arguments: typeof item.arguments === "string" ? item.arguments : "{}",
    }))
    .filter((call) => call.callId && call.name);
}

function filterFixContinuationItems(
  items: OpenAiResponseItem[],
): OpenAiResponseItem[] {
  return items.filter((item) => {
    const type = typeof item.type === "string" ? item.type : "unknown";
    if (
      type === "message" ||
      type === "function_call" ||
      type === "function_call_output"
    ) {
      return true;
    }
    return (
      type === "reasoning" &&
      typeof item.encrypted_content === "string" &&
      item.encrypted_content.trim().length > 0
    );
  });
}

function buildToolErrorOutput(error: unknown): string {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

function isEncryptedReasoningIncludeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("reasoning.encrypted_content") ||
    normalized.includes("encrypted_content")
  ) {
    return true;
  }
  return (
    normalized.includes("include") &&
    (normalized.includes("invalid") ||
      normalized.includes("unknown") ||
      normalized.includes("unsupported") ||
      normalized.includes("unrecognized") ||
      normalized.includes("not allowed"))
  );
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const stripped = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    return JSON.parse(stripped);
  }
  return JSON.parse(trimmed);
}

export function renderReviewMarkdown(input: {
  jiraTicket: string;
  pr: GitHubPullRequestInfo;
  model: string;
  reasoningEffort: string;
  review: CodexCodeReview;
  rules: RuleDocument[];
  usage?: CodexCodeReviewUsage | null;
  applyFixes?: boolean;
  fixResult?: CodexCodeReviewFixResult | null;
  fixCommit?: FixCommitResult | null;
  fixUsage?: CodexCodeReviewUsage | null;
}): string {
  const { review } = input;
  return [
    "# Codex-Code-Review Summary",
    "",
    `- Jira: ${input.jiraTicket}`,
    `- PR: ${input.pr.htmlUrl}`,
    `- Repository: ${input.pr.owner}/${input.pr.repo}`,
    `- Model: \`${input.model}\``,
    `- Reasoning effort: \`${input.reasoningEffort}\``,
    `- Verdict: **${review.verdict}**`,
    "",
    "## Summary",
    "",
    review.summary,
    "",
    "## Model Usage",
    "",
    renderUsageTable(input.usage ?? null, input.fixUsage ?? null),
    "",
    "## Jira Ask Coverage",
    "",
    renderCoverageTable(review.jiraAskCoverage),
    "",
    "## Missing Or Incorrect Implementation",
    "",
    renderFindings(
      review.missingOrIncorrect,
      "No missing or incorrect implementation findings.",
    ),
    "",
    "## Repository Rule Violations",
    "",
    renderFindings(
      review.ruleViolations,
      "No repository rule violations found.",
    ),
    "",
    "## Other Implementation Findings",
    "",
    renderFindings(
      review.implementationFindings,
      "No additional implementation findings.",
    ),
    "",
    "## Test Verification",
    "",
    renderStringList(
      review.testVerification,
      "No test verification notes returned.",
    ),
    "",
    "## Risk Notes",
    "",
    renderStringList(review.riskNotes, "No additional risks returned."),
    "",
    "## Evidence",
    "",
    renderStringList(review.evidence, "No evidence returned."),
    "",
    ...(input.applyFixes
      ? [
          "## Applied Fixes",
          "",
          renderAppliedFixes(input.fixResult ?? null, input.fixCommit ?? null),
          "",
        ]
      : []),
    "## Rules Used",
    "",
    input.rules.length > 0
      ? input.rules
          .map(
            (rule) =>
              `- \`${rule.path}\`${rule.truncated ? " (truncated)" : ""}`,
          )
          .join("\n")
      : "No repository rule files were found.",
    "",
  ].join("\n");
}

function renderUsageTable(
  reviewUsage: CodexCodeReviewUsage | null,
  fixUsage: CodexCodeReviewUsage | null,
): string {
  const rows = [
    ...(reviewUsage ? [{ phase: "Review", usage: reviewUsage }] : []),
    ...(fixUsage ? [{ phase: "Apply fixes", usage: fixUsage }] : []),
  ];
  if (rows.length === 0) {
    return "Token usage was not reported by the model API.";
  }
  if (rows.length > 1) {
    const costs = rows.map(({ usage }) => usage.estimatedCostUsd);
    rows.push({
      phase: "**Total**",
      usage: {
        inputTokens: rows.reduce(
          (sum, { usage }) => sum + usage.inputTokens,
          0,
        ),
        outputTokens: rows.reduce(
          (sum, { usage }) => sum + usage.outputTokens,
          0,
        ),
        cachedInputTokens: rows.reduce(
          (sum, { usage }) => sum + usage.cachedInputTokens,
          0,
        ),
        cacheWriteTokens: rows.reduce(
          (sum, { usage }) => sum + usage.cacheWriteTokens,
          0,
        ),
        totalTokens: rows.reduce(
          (sum, { usage }) => sum + usage.totalTokens,
          0,
        ),
        estimatedCostUsd: costs.every((cost) => cost !== null)
          ? Number(costs.reduce((sum, cost) => sum + (cost ?? 0), 0).toFixed(6))
          : null,
      },
    });
  }
  return [
    "| Phase | Input tokens | Cached input | Cache write | Output tokens | Total tokens | Estimated cost |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      ({ phase, usage }) =>
        `| ${phase} | ${formatTokenCount(usage.inputTokens)} | ${formatTokenCount(usage.cachedInputTokens)} | ${formatTokenCount(usage.cacheWriteTokens)} | ${formatTokenCount(usage.outputTokens)} | ${formatTokenCount(usage.totalTokens)} | ${formatEstimatedCost(usage.estimatedCostUsd)} |`,
    ),
    "",
    "Input tokens include cached input and cache-write tokens; those columns are not added again to total tokens. Cost uses configured standard API list rates and is an estimate; long-context or regional processing adjustments may differ.",
  ].join("\n");
}

function formatTokenCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatEstimatedCost(value: number | null): string {
  return value === null ? "unavailable" : `$${value.toFixed(6)}`;
}

function renderAppliedFixes(
  fixResult: CodexCodeReviewFixResult | null,
  fixCommit: FixCommitResult | null,
): string {
  if (!fixResult) {
    return "Fix application was requested, but no fix result was produced.";
  }
  const lines = [
    `- Applied: ${fixResult.applied ? "yes" : "no"}`,
    `- Summary: ${fixResult.summary}`,
  ];
  if (fixResult.changedFiles.length > 0) {
    lines.push(
      `- Agent-reported changed files: ${fixResult.changedFiles.map((file) => `\`${file}\``).join(", ")}`,
    );
  }
  if (fixCommit?.committed && fixCommit.commitSha) {
    lines.push(
      `- Commit: \`${fixCommit.commitSha}\` pushed to \`${fixCommit.repository}:${fixCommit.branch}\``,
    );
  } else if (fixCommit && !fixResult.applied && fixCommit.changedFiles.length) {
    lines.push(
      "- Commit: no commit was created because the fix agent reported incomplete changes.",
    );
  } else if (fixCommit) {
    lines.push(
      `- Commit: no commit was created because the checkout had no file changes.`,
    );
  }
  if (fixCommit?.changedFiles.length) {
    lines.push(
      `- Git changed files: ${fixCommit.changedFiles.map((file) => `\`${file}\``).join(", ")}`,
    );
  }
  if (fixResult.verificationNotes.length > 0) {
    lines.push(`- Verification: ${fixResult.verificationNotes.join("; ")}`);
  }
  if (fixResult.residualRisks.length > 0) {
    lines.push(`- Residual risks: ${fixResult.residualRisks.join("; ")}`);
  }
  if (fixCommit?.diffStat.trim()) {
    lines.push("", "```text", fixCommit.diffStat.trim(), "```");
  }
  return lines.join("\n");
}

function renderCoverageTable(
  items: Array<z.infer<typeof JiraAskCoverageSchema>>,
): string {
  if (items.length === 0) {
    return "No Jira coverage items returned.";
  }
  const lines = [
    "| Status | Requirement | Evidence |",
    "| --- | --- | --- |",
    ...items.map(
      (item) =>
        `| ${escapeMarkdownTable(item.status)} | ${escapeMarkdownTable(item.requirement)} | ${escapeMarkdownTable(item.evidence)} |`,
    ),
  ];
  return lines.join("\n");
}

function renderFindings(
  findings: Array<z.infer<typeof FindingSchema>>,
  emptyText: string,
): string {
  if (findings.length === 0) {
    return emptyText;
  }
  return findings
    .map((finding, index) =>
      [
        `${index + 1}. **${finding.severity.toUpperCase()} - ${finding.category}**`,
        `   - File: ${finding.file ? `\`${finding.file}${finding.line !== null ? `:${finding.line}` : ""}\`` : "n/a"}`,
        `   - Description: ${finding.description}`,
        `   - Evidence: ${finding.evidence}`,
        finding.relatedRule
          ? `   - Rule: \`${finding.relatedRule}\``
          : "   - Rule: n/a",
        `   - Recommendation: ${finding.recommendation}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function renderStringList(items: string[], emptyText: string): string {
  if (items.length === 0) {
    return emptyText;
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function buildReviewJobOutputs(
  review: CodexCodeReview,
  pr: GitHubPullRequestInfo,
): Record<string, string> {
  return {
    verdict: review.verdict,
    reviewed_head_sha: pr.headSha,
    apply_candidate: review.verdict === "NEEDS_CHANGES" ? "true" : "false",
  };
}

async function appendGitHubOutputs(
  outputPath: string | undefined,
  outputs: Record<string, string>,
): Promise<void> {
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => {
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error(`GitHub output ${key} must be a single-line value`);
    }
    return `${key}=${value}`;
  });
  await writeFile(outputPath, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}

async function loadReviewHandoff(
  reviewDir: string,
): Promise<CodexCodeReviewHandoff> {
  const reviewPath = path.join(reviewDir, "review.json");
  const metadataPath = path.join(reviewDir, "metadata.json");
  const review = CodexCodeReviewSchema.parse(
    JSON.parse(await readFile(reviewPath, "utf8")),
  );
  const parsedMetadata = CodexCodeReviewMetadataSchema.parse(
    JSON.parse(await readFile(metadataPath, "utf8")),
  );
  return {
    review,
    metadata: parsedMetadata as Record<string, unknown>,
    jiraTicket: parsedMetadata.jiraTicket,
    pr: parsedMetadata.pr,
    model: parsedMetadata.model,
    reasoningEffort: parsedMetadata.reasoningEffort,
    reviewUsage: parsedMetadata.usage?.review ?? null,
  };
}

export function assertApplyEligibility(input: {
  review: CodexCodeReview;
  reviewedPr: GitHubPullRequestInfo;
  currentPr: GitHubPullRequestInfo;
}): void {
  if (input.review.verdict !== "NEEDS_CHANGES") {
    throw new Error(
      `Apply phase requires a NEEDS_CHANGES review; received ${input.review.verdict}`,
    );
  }
  if (input.currentPr.state !== "open") {
    throw new Error(
      `Apply phase requires an open PR; current state is ${input.currentPr.state}`,
    );
  }
  const reviewedIdentity = `${input.reviewedPr.owner}/${input.reviewedPr.repo}#${input.reviewedPr.pullNumber}`;
  const currentIdentity = `${input.currentPr.owner}/${input.currentPr.repo}#${input.currentPr.pullNumber}`;
  if (currentIdentity !== reviewedIdentity) {
    throw new Error(
      `Review artifact targets ${reviewedIdentity}, but current PR is ${currentIdentity}`,
    );
  }
  if (
    input.currentPr.headSha !== input.reviewedPr.headSha ||
    input.currentPr.headRef !== input.reviewedPr.headRef ||
    input.currentPr.headRepoFullName !== input.reviewedPr.headRepoFullName
  ) {
    throw new Error(
      `PR head changed after review; reviewed ${input.reviewedPr.headRepoFullName}:${input.reviewedPr.headRef}@${input.reviewedPr.headSha}, current ${input.currentPr.headRepoFullName}:${input.currentPr.headRef}@${input.currentPr.headSha}. Run a fresh review before applying fixes.`,
    );
  }
}

async function assertWorkspaceHeadSha(
  workspacePath: string,
  expectedHeadSha: string,
): Promise<void> {
  const actualHeadSha = (
    await runGitCapture(["-C", workspacePath, "rev-parse", "HEAD"], {
      redact: [],
    })
  ).trim();
  if (actualHeadSha !== expectedHeadSha) {
    throw new Error(
      `Checked-out PR head ${actualHeadSha} does not match reviewed head ${expectedHeadSha}. Run a fresh review before applying fixes.`,
    );
  }
}

async function writeOutputs(input: {
  outputDir: string;
  markdown: string;
  review: CodexCodeReview;
  metadata: Record<string, unknown>;
  fixResult?: CodexCodeReviewFixResult | null;
  fixCommit?: FixCommitResult | null;
  fixUsage?: CodexCodeReviewUsage | null;
}): Promise<void> {
  await mkdir(input.outputDir, { recursive: true });
  await writeFile(
    path.join(input.outputDir, "review.md"),
    input.markdown,
    "utf8",
  );
  await writeFile(
    path.join(input.outputDir, "review.json"),
    `${JSON.stringify(input.review, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(input.outputDir, "metadata.json"),
    `${JSON.stringify(input.metadata, null, 2)}\n`,
    "utf8",
  );
  if (input.fixResult || input.fixCommit) {
    await writeFile(
      path.join(input.outputDir, "fixes.json"),
      `${JSON.stringify(
        {
          result: input.fixResult ?? null,
          commit: input.fixCommit ?? null,
          usage: input.fixUsage ?? null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

async function appendStepSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  await writeFile(summaryPath, markdown, { encoding: "utf8", flag: "a" });
}

interface CodexCodeReviewRunResult {
  review: CodexCodeReview;
  markdown: string;
  outputDir: string;
}

function createJiraClient(env: NodeJS.ProcessEnv): JiraClient {
  return new JiraClient({
    baseUrl: getRequiredEnv(env, ["JIRA_BASE_URL"]),
    username: getRequiredEnv(env, ["JIRA_USERNAME", "JIRA_EMAIL"]),
    token: getRequiredEnv(env, ["JIRA_TOKEN", "JIRA_API_TOKEN"]),
    downloadImages: false,
    maxAttachmentBytes: 120_000,
  });
}

async function runReviewPhase(
  args: CodexCodeReviewArgs,
  env: NodeJS.ProcessEnv,
): Promise<CodexCodeReviewRunResult> {
  const githubReadToken = getOptionalEnv(env, [
    "GITHUB_REPO_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);
  getRequiredEnv(env, ["OPENAI_API_KEY"]);
  const model = env.CODEX_CODE_REVIEW_MODEL?.trim() || DEFAULT_MODEL;
  const reasoningEffort =
    env.CODEX_CODE_REVIEW_REASONING_EFFORT?.trim() || DEFAULT_REASONING_EFFORT;

  console.log(`Fetching Jira ticket ${args.jiraTicket}`);
  const ticket = await createJiraClient(env).fetchTicketData(args.jiraTicket);

  console.log(`Fetching pull request ${args.prLink}`);
  const { pr, files, diff } = await fetchPullRequestEvidence(
    args.prLink,
    githubReadToken,
  );

  let cleanupPath: string | null = null;
  try {
    console.log(
      `Cloning PR head for review workspace: ${pr.owner}/${pr.repo}#${pr.pullNumber}`,
    );
    const checkout = await clonePullRequestHead({ pr, token: githubReadToken });
    cleanupPath = checkout.cleanupPath;
    await assertWorkspaceHeadSha(checkout.repoPath, pr.headSha);
    const rules = await collectReviewRules(
      checkout.repoPath,
      files.map((file) => file.filename),
    );
    const snapshots = await collectChangedFileSnapshots(
      checkout.repoPath,
      files,
    );

    console.log(
      `Calling OpenAI model ${model} with reasoning effort ${reasoningEffort}`,
    );
    const prompt = buildPrompt({
      jiraTicket: args.jiraTicket,
      ticket,
      pr,
      files,
      diff,
      rules,
      snapshots,
    });
    const { review, usage } = await callOpenAiReview({
      prompt,
      model,
      reasoningEffort,
      workspacePath: checkout.repoPath,
    });

    const markdown = renderReviewMarkdown({
      jiraTicket: args.jiraTicket,
      pr,
      model,
      reasoningEffort,
      review,
      rules,
      usage,
    });
    await writeOutputs({
      outputDir: args.outputDir,
      markdown,
      review,
      metadata: {
        jiraTicket: args.jiraTicket,
        pr,
        changedFiles: files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        })),
        rules: rules.map((rule) => ({
          path: rule.path,
          truncated: rule.truncated,
        })),
        model,
        reasoningEffort,
        usage: {
          review: usage,
        },
        phase: "review",
        applyCandidate: review.verdict === "NEEDS_CHANGES",
        reviewWorkspace: {
          source: "github-pull-head",
          fetchRef: `pull/${pr.pullNumber}/head`,
          headSha: pr.headSha,
          tempPath: checkout.repoPath,
        },
        generatedAt: new Date().toISOString(),
      },
    });
    await appendStepSummary(markdown);
    await appendGitHubOutputs(
      env.GITHUB_OUTPUT,
      buildReviewJobOutputs(review, pr),
    );

    if (args.postPrComment) {
      try {
        await postPullRequestComment({
          pr,
          token: githubReadToken,
          body: markdown,
        });
        console.log("Posted Codex-Code-Review summary to the PR");
      } catch (error) {
        console.warn(
          `Could not post PR comment: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { review, markdown, outputDir: args.outputDir };
  } finally {
    if (cleanupPath) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
  }
}

async function runApplyPhase(
  args: CodexCodeReviewArgs,
  env: NodeJS.ProcessEnv,
): Promise<CodexCodeReviewRunResult> {
  const handoff = await loadReviewHandoff(args.reviewDir);
  const githubReadToken = getOptionalEnv(env, [
    "GITHUB_REPO_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);
  const githubWriteToken = getOptionalEnv(env, [
    "GITHUB_WRITE_TOKEN",
    "GITHUB_REPO_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);
  if (!githubWriteToken) {
    throw new Error(
      "Apply phase requires GITHUB_WRITE_TOKEN, GITHUB_REPO_TOKEN, GH_TOKEN, or GITHUB_TOKEN with write access",
    );
  }
  getRequiredEnv(env, ["OPENAI_API_KEY"]);

  console.log(`Refreshing pull request ${handoff.pr.htmlUrl}`);
  const { pr, files, diff } = await fetchPullRequestEvidence(
    handoff.pr.htmlUrl,
    githubReadToken,
  );
  assertApplyEligibility({
    review: handoff.review,
    reviewedPr: handoff.pr,
    currentPr: pr,
  });

  console.log(`Refreshing Jira ticket ${handoff.jiraTicket}`);
  const ticket = await createJiraClient(env).fetchTicketData(
    handoff.jiraTicket,
  );

  let cleanupPath: string | null = null;
  try {
    console.log(
      `Cloning approved PR head for fix workspace: ${pr.owner}/${pr.repo}#${pr.pullNumber}`,
    );
    const checkout = await clonePullRequestHead({ pr, token: githubReadToken });
    cleanupPath = checkout.cleanupPath;
    await assertWorkspaceHeadSha(checkout.repoPath, handoff.pr.headSha);
    const rules = await collectReviewRules(
      checkout.repoPath,
      files.map((file) => file.filename),
    );

    console.log(
      `Applying approved fixes with OpenAI model ${handoff.model} and reasoning effort ${handoff.reasoningEffort}`,
    );
    const { result: fixResult, usage: fixUsage } = await callOpenAiFixAgent({
      jiraTicket: handoff.jiraTicket,
      ticket,
      pr,
      files,
      diff,
      rules,
      review: handoff.review,
      model: handoff.model,
      reasoningEffort: handoff.reasoningEffort,
      workspacePath: checkout.repoPath,
    });
    const fixCommit = await commitAndPushFixes({
      workspacePath: checkout.repoPath,
      pr,
      token: githubWriteToken,
      jiraTicket: handoff.jiraTicket,
      shouldCommit: fixResult.applied,
    });
    if (!fixResult.applied) {
      console.warn(
        "Codex-Code-Review fix agent reported incomplete changes; nothing was committed or pushed",
      );
    } else if (fixCommit.committed) {
      console.log(
        `Pushed Codex-Code-Review fixes to ${fixCommit.repository}:${fixCommit.branch} at ${fixCommit.commitSha}`,
      );
    } else {
      console.log("Codex-Code-Review fix phase produced no file changes");
    }

    const markdown = renderReviewMarkdown({
      jiraTicket: handoff.jiraTicket,
      pr,
      model: handoff.model,
      reasoningEffort: handoff.reasoningEffort,
      review: handoff.review,
      rules,
      applyFixes: true,
      fixResult,
      fixCommit,
      usage: handoff.reviewUsage,
      fixUsage,
    });
    await writeOutputs({
      outputDir: args.outputDir,
      markdown,
      review: handoff.review,
      metadata: {
        ...handoff.metadata,
        pr,
        model: handoff.model,
        reasoningEffort: handoff.reasoningEffort,
        usage: {
          review: handoff.reviewUsage,
          apply: fixUsage,
        },
        phase: "apply",
        fixes: {
          result: fixResult,
          commit: fixCommit,
        },
        applyWorkspace: {
          source: "github-pull-head",
          fetchRef: `pull/${pr.pullNumber}/head`,
          reviewedHeadSha: handoff.pr.headSha,
          appliedHeadSha: pr.headSha,
          tempPath: checkout.repoPath,
        },
        appliedAt: new Date().toISOString(),
      },
      fixResult,
      fixCommit,
      fixUsage,
    });
    await appendStepSummary(markdown);

    if (args.postPrComment) {
      try {
        await postPullRequestComment({
          pr,
          token: githubWriteToken,
          body: markdown,
        });
        console.log("Posted approved Codex-Code-Review fix summary to the PR");
      } catch (error) {
        console.warn(
          `Could not post PR comment: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { review: handoff.review, markdown, outputDir: args.outputDir };
  } finally {
    if (cleanupPath) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
  }
}

export async function runCodexCodeReview(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexCodeReviewRunResult> {
  const args = parseArgs(argv, env);
  return args.phase === "apply"
    ? runApplyPhase(args, env)
    : runReviewPhase(args, env);
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedFile === currentFile) {
  runCodexCodeReview().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exit(1);
  });
}
