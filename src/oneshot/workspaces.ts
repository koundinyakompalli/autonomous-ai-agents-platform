import { execFile, type ExecFileException } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import { REPO_REGISTRY, deregisterRepo } from "../claude-sdk/config.js";
import type { CodeRepository } from "../orchestrator/database.js";
import { createLogger } from "../utils/logger.js";
import { buildAuthenticatedRepoUrl, createOrResetLocalBranch } from "./git.js";
import {
  RepoCacheLeaseTimeoutError,
  WorkspaceCheckoutTimeoutError,
  WorkspaceLeaseLostError,
} from "./workspace-lease-errors.js";
import type {
  OneShotWorkspaceLease,
  OneShotWorkspaceLeasesDB,
} from "./database/workspace-leases.js";
import type { OneShotWorkspaceStateDB } from "./database/workspace-state.js";
import {
  leaseHeartbeatFailureCounter,
  repoCacheColdHydrationDurationHistogram,
  repoCacheLockHoldHistogram,
  repoCacheLockWaitHistogram,
  repoFetchDurationHistogram,
  workspaceLockWaitHistogram,
  workspaceCleanupSkippedCounter,
  workspaceReuseCounter,
  worktreePrepareDurationHistogram,
} from "./telemetry/metrics.js";
import type { OneShotDatabase } from "./database/index.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("oneshot-workspaces");
const GIT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_DISCOVERY_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const GIT_LOG_TAIL_CHARS = 4_000;
const CACHE_STATE_FILENAME = "oneshot-cache-state.json";
const LEASE_HEARTBEAT_FAILURE_THRESHOLD = 3;
const REMOTE_TRACKING_FETCH_REFSPEC =
  "+refs/heads/*:refs/remotes/origin/*";

export class RetrofitSourceBranchMissingError extends Error {
  constructor(
    public readonly branchName: string,
    cause: unknown,
  ) {
    super(
      `retrofit_source_branch_missing: Retrofit source branch ${branchName} was not found on origin.`,
    );
    this.name = "RetrofitSourceBranchMissingError";
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export function isMissingRemoteBranchFetchError(error: unknown): boolean {
  const gitError = error as
    | (Error & { stderr?: string | Buffer })
    | null
    | undefined;
  const stderr =
    typeof gitError?.stderr === "string"
      ? gitError.stderr
      : Buffer.isBuffer(gitError?.stderr)
        ? gitError.stderr.toString("utf8")
        : "";
  const message = gitError instanceof Error ? gitError.message : String(error);
  const text = `${message}\n${stderr}`.toLowerCase();
  return (
    text.includes("couldn't find remote ref") ||
    text.includes("could not find remote ref") ||
    text.includes("remote ref does not exist") ||
    text.includes("couldn't find remote branch") ||
    text.includes("could not find remote branch")
  );
}

export interface WorkspaceConfig {
  repoBasePath: string;
  repoCacheBasePath?: string;
  workspaceBasePath: string;
  worktreeBasePath?: string;
  leaseStore?: OneShotWorkspaceLeasesDB;
  workspaceStateStore?: OneShotWorkspaceStateDB;
  leaseOwnerTaskArn?: string;
  leaseTtlSeconds?: number;
  leaseHeartbeatSeconds?: number;
  repoCacheFreshnessTtlMs?: number;
}

export interface PreparedWorkspace {
  repoRoot: string;
  runPath: string;
  workspacePath: string;
  statePath: string;
  lease?: OneShotWorkspaceLease;
  assertLeaseValid?: (stage?: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

export interface PrepareWorkspaceOptions {
  repoCacheLeaseMaxWaitMs?: number;
  repoCacheLeaseMetadata?: Record<string, unknown>;
}

export type OneShotStage =
  | "planner"
  | "reviewer"
  | "implementer"
  | "code-reviewer"
  | "tester";

interface WorktreeLogContext {
  action?: string;
  repo?: string;
  repoRoot?: string;
  runPath?: string;
  workspacePath?: string;
  statePath?: string;
  baseCommitSha?: string;
  branchName?: string;
  localBranchName?: string;
  runId?: number;
  stage?: string;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

interface GitWorktreeEntry {
  worktreePath: string;
  lockedReason?: string;
  prunableReason?: string;
}

interface LeaseHeartbeatState {
  consecutiveFailures: number;
  lost: boolean;
  recordedLost: boolean;
}

interface LeaseCommandGuard {
  lease: OneShotWorkspaceLease;
  stage: string;
  heartbeatState?: LeaseHeartbeatState;
  additionalLeases?: OneShotWorkspaceLease[];
}

interface RepoCacheBranchState {
  lastFetchAt: string;
  remoteHeadSha: string | null;
}

interface RepoCacheState {
  branches?: Record<string, RepoCacheBranchState>;
}

export type RepoFetchReason =
  | "clone"
  | "fresh_cache"
  | "candidate_sha_local"
  | "missing_required_sha"
  | "missing_cache_state"
  | "stale_cache"
  | "unscoped_fetch";

export type RepoBranchFetchPolicy =
  | "freshness_required"
  | "candidate_sha_authoritative";

type RepoCacheLeasePhase =
  | "fetch"
  | "noop"
  | "rebuild"
  | "worktree_add"
  | "worktree_ref"
  | "cleanup";

interface HydratedRepo {
  repoRoot: string;
  lastRepoFetchAt: Date | null;
  lastRemoteHeadSha?: string | null;
  fetchReason: RepoFetchReason;
}

export type CleanupRunWorkspaceStatus =
  | "cleaned"
  | "not_found"
  | "skipped_lease_held";

export interface PreparedBranchWorkspace extends PreparedWorkspace {
  branchName: string;
  headSha: string;
  repoFetchReason: RepoFetchReason;
  reused: boolean;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function redactGitText(value: string): string {
  return value.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}

function formatGitCommandForLog(args: string[]): string {
  return ["git", ...args.map((arg) => JSON.stringify(redactGitText(arg)))].join(
    " ",
  );
}

function isWorktreeAddGitArgs(args: string[]): boolean {
  const worktreeIndex = args.findIndex((arg) => arg === "worktree");
  return worktreeIndex >= 0 && args[worktreeIndex + 1] === "add";
}

function getLogTail(value: string | Buffer | undefined): string | undefined {
  const text =
    typeof value === "string" ? value : (value?.toString("utf8") ?? "");
  const normalized = redactGitText(text).trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length <= GIT_LOG_TAIL_CHARS
    ? normalized
    : normalized.slice(-GIT_LOG_TAIL_CHARS);
}

function parseRepoCacheState(value: string): RepoCacheState {
  try {
    const parsed = JSON.parse(value) as RepoCacheState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function cacheEntryIsFresh(
  entry: RepoCacheBranchState | undefined,
  ttlMs: number,
): boolean {
  if (!entry?.lastFetchAt) {
    return false;
  }
  const lastFetchMs = Date.parse(entry.lastFetchAt);
  return Number.isFinite(lastFetchMs) && Date.now() - lastFetchMs <= ttlMs;
}

function getComparablePathCandidates(targetPath: string): Set<string> {
  const resolved = path.resolve(targetPath);
  const candidates = new Set([resolved]);

  if (
    resolved === "/var" ||
    resolved.startsWith("/var/") ||
    resolved === "/tmp" ||
    resolved.startsWith("/tmp/")
  ) {
    candidates.add(path.join("/private", resolved));
  }

  if (
    resolved === "/private/var" ||
    resolved.startsWith("/private/var/") ||
    resolved === "/private/tmp" ||
    resolved.startsWith("/private/tmp/")
  ) {
    candidates.add(resolved.slice("/private".length));
  }

  return candidates;
}

function pathsReferToSameLocation(
  leftPath: string,
  rightPath: string,
): boolean {
  const leftCandidates = getComparablePathCandidates(leftPath);
  const rightCandidates = getComparablePathCandidates(rightPath);

  for (const candidate of leftCandidates) {
    if (rightCandidates.has(candidate)) {
      return true;
    }
  }

  return false;
}

function parseGitWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = {
        worktreePath: rawLine.slice(rawLine.indexOf(" ") + 1).trim(),
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (trimmed === "locked") {
      current.lockedReason = "locked";
      continue;
    }

    if (trimmed.startsWith("locked ")) {
      current.lockedReason =
        rawLine.slice(rawLine.indexOf(" ") + 1).trim() || "locked";
      continue;
    }

    if (trimmed === "prunable") {
      current.prunableReason = "prunable";
      continue;
    }

    if (trimmed.startsWith("prunable ")) {
      current.prunableReason =
        rawLine.slice(rawLine.indexOf(" ") + 1).trim() || "prunable";
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

function dedupeAdditionalBranches(
  primaryBranchName: string | undefined,
  additionalBranchNames: string[],
): string[] {
  return Array.from(
    new Set(
      additionalBranchNames
        .map((branchName) => branchName.trim())
        .filter(
          (branchName) =>
            branchName.length > 0 && branchName !== primaryBranchName,
        ),
    ),
  );
}

export class OneShotWorkspaceManager {
  constructor(protected readonly config: WorkspaceConfig) {}

  private get repoCacheBasePath(): string {
    return this.config.repoCacheBasePath ?? this.config.repoBasePath;
  }

  private get worktreeBasePath(): string {
    return this.config.worktreeBasePath ?? this.config.workspaceBasePath;
  }

  private legacyRunPath(runId: number): string {
    return path.join(this.config.workspaceBasePath, String(runId));
  }

  private v2RunPath(runId: number): string {
    return path.join(this.worktreeBasePath, String(runId));
  }

  private branchRunPath(runId: number): string {
    return this.config.worktreeBasePath
      ? this.v2RunPath(runId)
      : this.legacyRunPath(runId);
  }

  private branchWorkspaceDirectoryName(): "workspace" | "worktree" {
    return this.config.worktreeBasePath ? "worktree" : "workspace";
  }

  private repoMirrorRoot(repoName: string): string {
    return path.join(this.repoCacheBasePath, `${repoName}.git`);
  }

  private isBareRepoCacheRootPath(repoRoot: string): boolean {
    return path.basename(repoRoot).endsWith(".git");
  }

  private repoGitArgs(repoRoot: string, args: string[]): string[] {
    return this.isBareRepoCacheRootPath(repoRoot)
      ? [`--git-dir=${repoRoot}`, ...args]
      : args;
  }

  private repoGitCwd(repoRoot: string): string {
    return this.isBareRepoCacheRootPath(repoRoot)
      ? path.dirname(repoRoot)
      : repoRoot;
  }

  private recordRepoCacheLockHold(input: {
    repoName: string;
    phase: RepoCacheLeasePhase;
    stage: string;
    durationMs: number;
  }): void {
    repoCacheLockHoldHistogram.record(input.durationMs, {
      repo_name: input.repoName,
      phase: input.phase,
      stage: input.stage,
    });
    logger.info(
      {
        repo: input.repoName,
        phase: input.phase,
        stage: input.stage,
        durationMs: input.durationMs,
      },
      "Held OneShot repo-cache lease",
    );
  }

  async prepareWorkspace(
    runId: number,
    repo: Pick<CodeRepository, "repo_name" | "repo_url">,
    baseCommitSha: string,
    stage: OneShotStage,
    branchName?: string,
    localBranchName?: string,
    additionalBranchNames: string[] = [],
    branchFetchPolicy: RepoBranchFetchPolicy = "freshness_required",
    options: PrepareWorkspaceOptions = {},
  ): Promise<PreparedWorkspace> {
    return this.preparePinnedWorkspace(
      runId,
      repo,
      baseCommitSha,
      stage,
      branchName,
      localBranchName,
      additionalBranchNames,
      branchFetchPolicy,
      options,
    );
  }

  async prepareBranchWorkspace(input: {
    runId: number;
    repo: Pick<CodeRepository, "repo_name" | "repo_url">;
    branchName: string;
    stage: OneShotStage;
    branchFetchPolicy?: RepoBranchFetchPolicy;
  }): Promise<PreparedBranchWorkspace> {
    const startedAt = Date.now();
    const branchRef = `refs/remotes/origin/${input.branchName}`;
    const hydratedRepo = await this.ensureHydratedRepoForPinnedWorkspace(
      input.repo,
      branchRef,
      input.branchName,
      undefined,
      input.branchFetchPolicy ?? "freshness_required",
    );
    const repoRoot = hydratedRepo.repoRoot;
    const headSha = await this.runRepoGitQuery(["rev-parse", branchRef], repoRoot);
    const runPath = this.branchRunPath(input.runId);
    const workspacePath = path.join(
      runPath,
      this.branchWorkspaceDirectoryName(),
    );
    const statePath = path.join(runPath, "state");
    const logContext: WorktreeLogContext = {
      repo: input.repo.repo_name,
      repoRoot,
      runPath,
      workspacePath,
      statePath,
      baseCommitSha: headSha,
      branchName: input.branchName,
      runId: input.runId,
      stage: input.stage,
    };

    const reused = await this.tryReuseWorktree(
      repoRoot,
      workspacePath,
      headSha,
      logContext,
    );
    if (!reused) {
      await this.cleanupWorktree(repoRoot, workspacePath, {
        ...logContext,
        action: "git_worktree_preflight_branch",
      });
      try {
        await fs.mkdir(runPath, { recursive: true });
        await this.runRepoGitStep(
          ["worktree", "add", "--detach", workspacePath, headSha],
          repoRoot,
          {
            ...logContext,
            action: "git_worktree_add_branch",
          },
        );
      } catch (error) {
        await this.cleanupWorktree(repoRoot, workspacePath, {
          ...logContext,
          action: "git_worktree_failed_add_branch_cleanup",
        }).catch(() => undefined);
        await fs.rm(runPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }

    await fs.mkdir(statePath, { recursive: true });
    await this.cleanupStageState(statePath, input.stage);
    workspaceReuseCounter.add(1, {
      stage: input.stage,
      repo_name: input.repo.repo_name,
      mode: reused ? "reused_branch" : "created_branch",
    });
    worktreePrepareDurationHistogram.record(Date.now() - startedAt, {
      stage: input.stage,
      repo_name: input.repo.repo_name,
      workspace_mode: "branch",
    });

    logger.info(
      {
        ...logContext,
        reused,
        branchName: input.branchName,
        repoFetchReason: hydratedRepo.fetchReason,
      },
      "Prepared OneShot branch workspace",
    );

    return {
      repoRoot,
      runPath,
      workspacePath,
      statePath,
      cleanup: async () => {
        await this.cleanupWorktree(repoRoot, workspacePath, {
          ...logContext,
          action: "git_worktree_branch_cleanup",
        });
        await fs.rm(runPath, { recursive: true, force: true }).catch(() => undefined);
      },
      branchName: input.branchName,
      headSha,
      repoFetchReason: hydratedRepo.fetchReason,
      reused,
    };
  }

  protected async preparePinnedWorkspace(
    runId: number,
    repo: Pick<CodeRepository, "repo_name" | "repo_url">,
    expectedCommitSha: string,
    stage: OneShotStage,
    branchName?: string,
    localBranchName?: string,
    additionalBranchNames: string[] = [],
    branchFetchPolicy: RepoBranchFetchPolicy = "freshness_required",
    options: PrepareWorkspaceOptions = {},
  ): Promise<PreparedWorkspace> {
    if (!this.config.leaseStore || !this.config.workspaceStateStore) {
      throw new Error("Workspace v2 requires lease and workspace-state stores");
    }

    const startedAt = Date.now();
    const repoScope = `repo-cache:${repo.repo_name}`;
    const runScope = `run-worktree:${runId}`;
    const ownerTaskArn =
      this.config.leaseOwnerTaskArn ??
      process.env.ECS_TASK_ARN ??
      `pid:${process.pid}`;
    const leaseTtlSeconds = this.config.leaseTtlSeconds ?? 2700;
    const heartbeatSeconds = this.config.leaseHeartbeatSeconds ?? 30;

    let repoLease: OneShotWorkspaceLease | null = null;
    let repoLeasePhase: RepoCacheLeasePhase = "fetch";
    let repoLeaseHeldStartedAt = 0;
    const markRepoLeasePhase = (phase: RepoCacheLeasePhase) => {
      if (repoLease) {
        this.recordRepoCacheLockHold({
          repoName: repo.repo_name,
          phase: repoLeasePhase,
          stage,
          durationMs: Date.now() - repoLeaseHeldStartedAt,
        });
        repoLeaseHeldStartedAt = Date.now();
      }
      repoLeasePhase = phase;
    };
    const acquireRepoLease = async (phase: RepoCacheLeasePhase = "fetch") => {
      if (repoLease) {
        if (repoLeasePhase !== phase) {
          markRepoLeasePhase(phase);
        }
        return repoLease;
      }
      repoLease = await this.acquireLeaseWithRetry(
        repoScope,
        ownerTaskArn,
        stage,
        leaseTtlSeconds,
        {
          maxWaitMs: options.repoCacheLeaseMaxWaitMs,
          metadata: options.repoCacheLeaseMetadata,
        },
      );
      repoLeasePhase = phase;
      repoLeaseHeldStartedAt = Date.now();
      return repoLease;
    };
    const releaseRepoLease = async (phase?: RepoCacheLeasePhase) => {
      if (!repoLease) {
        return;
      }
      if (phase && repoLeasePhase !== phase) {
        repoLeasePhase = phase;
      }
      this.recordRepoCacheLockHold({
        repoName: repo.repo_name,
        phase: repoLeasePhase,
        stage,
        durationMs: Date.now() - repoLeaseHeldStartedAt,
      });
      const leaseToRelease = repoLease;
      repoLease = null;
      await this.config.leaseStore
        .releaseLease(leaseToRelease.scope, leaseToRelease.fencingToken)
        .catch(() => undefined);
    };
    let runLease: OneShotWorkspaceLease | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    const heartbeatState: LeaseHeartbeatState = {
      consecutiveFailures: 0,
      lost: false,
      recordedLost: false,
    };
    try {
      const repoFetchStartedAt = Date.now();
      const fetchRepoLease = await acquireRepoLease("fetch");
      const repoGuard: LeaseCommandGuard = {
        lease: fetchRepoLease,
        stage,
      };
      const hydratedRepo = await this.ensureHydratedRepoForPinnedWorkspace(
        repo,
        expectedCommitSha,
        branchName,
        repoGuard,
        branchFetchPolicy,
      );
      const repoRoot = hydratedRepo.repoRoot;
      const additionalBranchNamesToFetch = dedupeAdditionalBranches(
        branchName,
        additionalBranchNames,
      );
      for (const additionalBranchName of additionalBranchNamesToFetch) {
        await this.fetchAdditionalBranch(
          repo,
          repoRoot,
          additionalBranchName,
          undefined,
          "missing_cache_state",
          repoGuard,
        );
      }
      repoFetchDurationHistogram.record(Date.now() - repoFetchStartedAt, {
        repo_name: repo.repo_name,
        stage,
      });
      // Release shared Git metadata before waiting on the per-run lease; worktree add reacquires it only when needed.
      await releaseRepoLease(
        hydratedRepo.fetchReason === "fresh_cache" &&
          additionalBranchNamesToFetch.length === 0
          ? "noop"
          : "fetch",
      );

      runLease = await this.acquireLeaseWithRetry(
        runScope,
        ownerTaskArn,
        stage,
        leaseTtlSeconds,
      );
      heartbeatTimer = this.startLeaseHeartbeat({
        leases: [runLease],
        heartbeatState,
        stage,
        runId,
        repoName: repo.repo_name,
        ttlSeconds: leaseTtlSeconds,
        intervalSeconds: heartbeatSeconds,
      });
      const workspaceGuard: LeaseCommandGuard = {
        lease: runLease,
        stage,
        heartbeatState,
      };
      const workspaceRepoGuard = async (
        phase: RepoCacheLeasePhase,
      ): Promise<LeaseCommandGuard> => ({
        lease: runLease!,
        stage,
        heartbeatState,
        additionalLeases: [await acquireRepoLease(phase)],
      });

      const runPath = this.v2RunPath(runId);
      const workspacePath = path.join(runPath, "worktree");
      const statePath = path.join(runPath, "state");
      const logContext: WorktreeLogContext = {
        repo: repo.repo_name,
        repoRoot,
        runPath,
        workspacePath,
        statePath,
        baseCommitSha: expectedCommitSha,
        branchName,
        runId,
        stage,
      };

      await this.verifyLeaseGuard(workspaceGuard);
      const workspaceExists = await pathExists(workspacePath);
      let reused = false;
      let shouldCreateWorktree = !workspaceExists;
      let cleanedBeforeCreate = false;
      if (workspaceExists) {
        const workspaceHead = await this.getHeadSha(workspacePath).catch(
          (error: unknown) => {
            logger.warn(
              {
                ...logContext,
                error: error instanceof Error ? error.message : String(error),
              },
              "Pinned OneShot worktree HEAD could not be read; rebuilding worktree",
            );
            return null;
          },
        );
        if (workspaceHead !== expectedCommitSha) {
          logger.warn(
            {
              ...logContext,
              workspaceHead,
              expectedCommitSha,
            },
            "Pinned OneShot worktree HEAD differs from expected SHA; rebuilding worktree",
          );
          await this.cleanupWorktree(
            repoRoot,
            workspacePath,
            {
              ...logContext,
              action: "git_worktree_rebuild_v2",
            },
            await workspaceRepoGuard("rebuild"),
          );
          cleanedBeforeCreate = true;
          shouldCreateWorktree = true;
        } else {
          reused = true;
        }
      }

      if (shouldCreateWorktree) {
        if (!cleanedBeforeCreate) {
          await this.cleanupWorktree(
            repoRoot,
            workspacePath,
            {
              ...logContext,
              action: "git_worktree_preflight_v2",
            },
            await workspaceRepoGuard("cleanup"),
          );
        }
        await fs.mkdir(runPath, { recursive: true });
        await this.runRepoGitStepWithLease(
          ["worktree", "add", "--detach", workspacePath, expectedCommitSha],
          repoRoot,
          {
            ...logContext,
            action: "git_worktree_add_v2",
          },
          await workspaceRepoGuard("worktree_add"),
        );
      }

      if (reused) {
        await this.runGitStepWithLease(
          ["switch", "--detach", expectedCommitSha],
          workspacePath,
          {
            ...logContext,
            action: "git_switch_detach_v2",
          },
          await workspaceRepoGuard("worktree_ref"),
        );
        // Drop the repo-cache lease before reset/clean; those mutate only the per-run worktree after detaching.
        await releaseRepoLease();
        await this.runGitStepWithLease(
          ["reset", "--hard", expectedCommitSha],
          workspacePath,
          {
            ...logContext,
            action: "git_reset_hard_v2",
          },
          workspaceGuard,
        );
        await this.runGitStepWithLease(
          ["clean", "-ffd"],
          workspacePath,
          {
            ...logContext,
            action: "git_clean_v2",
          },
          workspaceGuard,
        );
      }

      if (localBranchName) {
        await this.runGitStepWithLease(
          ["switch", "-C", localBranchName, expectedCommitSha],
          workspacePath,
          {
            ...logContext,
            action: "git_switch_local_branch_v2",
            localBranchName,
          },
          await workspaceRepoGuard("worktree_ref"),
        );
        await releaseRepoLease();
      } else {
        await releaseRepoLease();
      }

      await fs.mkdir(statePath, { recursive: true });
      await this.cleanupStageState(statePath, stage);
      const workspaceHeadSha = workspaceExists
        ? await this.getHeadSha(workspacePath).catch(() => null)
        : expectedCommitSha;
      const stateRecorded =
        await this.config.workspaceStateStore.upsertStateWithLease({
          oneshotRunId: runId,
          workspaceMode: "v2",
          workspacePath,
          statePath,
          workspacePhase: stage,
          workspaceHeadSha,
          baseCommitSha:
            stage === "planner" || stage === "reviewer"
              ? expectedCommitSha
              : undefined,
          lastRepoFetchAt: hydratedRepo.lastRepoFetchAt,
          lastRemoteHeadSha: hydratedRepo.lastRemoteHeadSha,
          metadata: {
            repoName: repo.repo_name,
            branchName: branchName ?? null,
            reused,
            expectedCommitSha,
            repoCacheFetchReason: hydratedRepo.fetchReason,
          },
          leaseScope: runLease.scope,
          fencingToken: runLease.fencingToken,
        });
      if (!stateRecorded) {
        await this.config.leaseStore.recordLeaseLost(
          runLease.scope,
          stage,
          "workspace_state_prepare",
        );
        throw new Error(
          `Lost OneShot workspace lease ${runLease.scope} before recording prepared workspace state`,
        );
      }

      workspaceReuseCounter.add(1, {
        stage,
        repo_name: repo.repo_name,
        mode: reused ? "reused_v2" : "created_v2",
      });
      worktreePrepareDurationHistogram.record(Date.now() - startedAt, {
        stage,
        repo_name: repo.repo_name,
        workspace_mode: "v2",
      });

      logger.info(
        {
          ...logContext,
          reused,
          workspaceMode: "v2",
          leaseScope: runLease.scope,
          fencingToken: runLease.fencingToken,
        },
        "Prepared pinned OneShot workspace",
      );

      const heldLease = runLease;
      const release = async () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (runLease) {
          await this.config.leaseStore?.releaseLease(
            runLease.scope,
            runLease.fencingToken,
          );
          runLease = null;
        }
      };

      return {
        repoRoot,
        runPath,
        workspacePath,
        statePath,
        lease: heldLease,
        assertLeaseValid: async (assertStage = stage) =>
          this.verifyHeldLease(heldLease, assertStage, heartbeatState),
        cleanup: release,
      };
    } catch (error) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (runLease) {
        await this.config.leaseStore
          .releaseLease(runLease.scope, runLease.fencingToken)
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await releaseRepoLease();
    }
  }

  async preparePlannerWorkspace(
    runId: number,
    repo: Pick<CodeRepository, "repo_name" | "repo_url">,
    baseCommitSha: string,
    branchName?: string,
    additionalBranchNames: string[] = [],
    options: PrepareWorkspaceOptions = {},
  ): Promise<PreparedWorkspace> {
    return this.prepareWorkspace(
      runId,
      repo,
      baseCommitSha,
      "planner",
      branchName,
      undefined,
      additionalBranchNames,
      "freshness_required",
      options,
    );
  }

  async prepareReviewerWorkspace(
    runId: number,
    repo: Pick<CodeRepository, "repo_name" | "repo_url">,
    baseCommitSha: string,
    branchName?: string,
  ): Promise<PreparedWorkspace> {
    return this.prepareWorkspace(
      runId,
      repo,
      baseCommitSha,
      "reviewer",
      branchName,
    );
  }

  async prepareImplementerWorkspace(
    runId: number,
    repo: Pick<CodeRepository, "repo_name" | "repo_url">,
    baseCommitSha: string,
    implementationBranch: string,
    branchName?: string,
    additionalBranchNames: string[] = [],
  ): Promise<PreparedWorkspace> {
    const workspace = await this.prepareWorkspace(
      runId,
      repo,
      baseCommitSha,
      "implementer",
      branchName,
      implementationBranch,
      additionalBranchNames,
    );
    if (!workspace.lease) {
      await createOrResetLocalBranch(
        workspace.workspacePath,
        implementationBranch,
      );
    }
    return workspace;
  }

  async prepareCodeReviewerWorkspace(
    runId: number,
    repo: Pick<CodeRepository, "repo_name" | "repo_url">,
    commitSha: string,
    branchName?: string,
  ): Promise<PreparedWorkspace> {
    return this.prepareWorkspace(
      runId,
      repo,
      commitSha,
      "code-reviewer",
      branchName,
      undefined,
      [],
      "candidate_sha_authoritative",
    );
  }

  async prepareTesterWorkspace(
    runId: number,
    repo: Pick<CodeRepository, "repo_name" | "repo_url">,
    commitSha: string,
    implementationBranch: string,
    branchName?: string,
  ): Promise<PreparedWorkspace> {
    const workspace = await this.prepareWorkspace(
      runId,
      repo,
      commitSha,
      "tester",
      branchName,
      implementationBranch,
      [],
      "candidate_sha_authoritative",
    );
    if (!workspace.lease) {
      await createOrResetLocalBranch(
        workspace.workspacePath,
        implementationBranch,
      );
    }
    return workspace;
  }

  async cleanupRunWorkspace(runId: number): Promise<CleanupRunWorkspaceStatus> {
    const legacyRunPath = this.legacyRunPath(runId);
    const v2RunPath = this.v2RunPath(runId);
    const runPaths = Array.from(new Set([legacyRunPath, v2RunPath]));
    const v2WorkspacePath = path.join(v2RunPath, "worktree");
    const workspacePaths = Array.from(
      new Set(
        runPaths.flatMap((runPath) => [
          path.join(runPath, "workspace"),
          path.join(runPath, "worktree"),
        ]),
      ),
    );
    const runPathExists = (
      await Promise.all(runPaths.map((runPath) => pathExists(runPath)))
    ).some(Boolean);
    const v2WorkspaceExists = (
      await Promise.all(
        runPaths.map((runPath) => pathExists(path.join(runPath, "worktree"))),
      )
    ).some(Boolean);
    const cleanupRequiresLease = Boolean(
      this.config.leaseStore && (runPathExists || v2WorkspaceExists),
    );

    const resolvedRepoRoots = new Map<string, string>();
    for (const workspacePath of workspacePaths) {
      const workspaceExists = await pathExists(workspacePath);
      const repoRoot = await this.resolveRepoRootForWorkspace(workspacePath);
      if (workspaceExists && !repoRoot) {
        throw new Error(
          `Unable to resolve repository root for OneShot workspace ${workspacePath}`,
        );
      }
      if (repoRoot) {
        resolvedRepoRoots.set(workspacePath, repoRoot);
      }
    }

    const cleanupRepoLeases: OneShotWorkspaceLease[] = [];
    const cleanupRepoLeaseStartedAt = new Map<string, number>();
    const releaseCleanupRepoLeases = async () => {
      for (const acquiredLease of [...cleanupRepoLeases].reverse()) {
        const startedAt = cleanupRepoLeaseStartedAt.get(acquiredLease.scope);
        if (startedAt !== undefined) {
          this.recordRepoCacheLockHold({
            repoName: acquiredLease.scope.replace(/^repo-cache:/, ""),
            phase: "cleanup",
            stage: "cleanup",
            durationMs: Date.now() - startedAt,
          });
          cleanupRepoLeaseStartedAt.delete(acquiredLease.scope);
        }
        await this.config.leaseStore
          ?.releaseLease(acquiredLease.scope, acquiredLease.fencingToken)
          .catch(() => undefined);
      }
      cleanupRepoLeases.length = 0;
    };
    const repoLeaseScopes = cleanupRequiresLease
      ? Array.from(
          new Set(
            Array.from(resolvedRepoRoots.values()).map((repoRoot) =>
              this.repoCacheScopeForRepoRoot(repoRoot),
            ),
          ),
        ).sort()
      : [];
    for (const repoLeaseScope of repoLeaseScopes) {
      const cleanupRepoLease = await this.config.leaseStore!.acquireLease({
        scope: repoLeaseScope,
        ownerTaskArn:
          this.config.leaseOwnerTaskArn ??
          process.env.ECS_TASK_ARN ??
          `pid:${process.pid}`,
        ownerStage: "cleanup",
        ttlSeconds: this.config.leaseTtlSeconds ?? 2700,
        metadata: { runId, operation: "cleanup" },
      });
      if (!cleanupRepoLease) {
        workspaceCleanupSkippedCounter.add(1, {
          scope: repoLeaseScope,
          reason: "repo_cache_lease_held",
        });
        logger.warn(
          {
            runId,
            runPaths,
            workspacePath: v2WorkspacePath,
            leaseScope: repoLeaseScope,
          },
          "Skipping OneShot v2 workspace cleanup because the repo-cache lease is active",
        );
        await releaseCleanupRepoLeases();
        return "skipped_lease_held";
      }
      cleanupRepoLeases.push(cleanupRepoLease);
      cleanupRepoLeaseStartedAt.set(repoLeaseScope, Date.now());
    }

    let cleanupLease: OneShotWorkspaceLease | null = null;
    let cleanupHeartbeatTimer: NodeJS.Timeout | null = null;
    const cleanupHeartbeatState: LeaseHeartbeatState = {
      consecutiveFailures: 0,
      lost: false,
      recordedLost: false,
    };
    try {
      cleanupLease = cleanupRequiresLease
        ? await this.config.leaseStore.acquireLease({
            scope: `run-worktree:${runId}`,
            ownerTaskArn:
              this.config.leaseOwnerTaskArn ??
              process.env.ECS_TASK_ARN ??
              `pid:${process.pid}`,
            ownerStage: "cleanup",
            ttlSeconds: this.config.leaseTtlSeconds ?? 2700,
            metadata: { runId, operation: "cleanup" },
          })
        : null;
    } catch (error) {
      await releaseCleanupRepoLeases();
      throw error;
    }

    if (cleanupRequiresLease && !cleanupLease) {
      workspaceCleanupSkippedCounter.add(1, {
        scope: `run-worktree:${runId}`,
        reason: "lease_held",
      });
      logger.warn(
        {
          runId,
          runPaths,
          workspacePath: v2WorkspacePath,
          leaseScope: `run-worktree:${runId}`,
        },
        "Skipping OneShot v2 workspace cleanup because the run-worktree lease is active",
      );
      await releaseCleanupRepoLeases();
      return "skipped_lease_held";
    }

    try {
      if (cleanupLease) {
        cleanupHeartbeatTimer = this.startLeaseHeartbeat({
          leases: [...cleanupRepoLeases, cleanupLease],
          heartbeatState: cleanupHeartbeatState,
          stage: "cleanup",
          runId,
          repoName: "cleanup",
          ttlSeconds: this.config.leaseTtlSeconds ?? 2700,
          intervalSeconds: this.config.leaseHeartbeatSeconds ?? 30,
        });
      }
      const cleanupGuard: LeaseCommandGuard | undefined = cleanupLease
        ? {
            lease: cleanupLease,
            stage: "cleanup",
            additionalLeases: cleanupRepoLeases,
            heartbeatState: cleanupHeartbeatState,
          }
        : undefined;

      for (const [id, registeredPath] of Object.entries(REPO_REGISTRY)) {
        if (runPaths.some((runPath) => registeredPath.startsWith(runPath))) {
          deregisterRepo(id);
        }
      }

      let status: CleanupRunWorkspaceStatus = "not_found";
      let lastRepoRoot: string | null = null;
      for (const workspacePath of workspacePaths) {
        const repoRoot = resolvedRepoRoots.get(workspacePath);
        if (repoRoot) {
          lastRepoRoot = repoRoot;
          const cleanupStatus = await this.cleanupWorktree(
            repoRoot,
            workspacePath,
            {
              action: "git_worktree_terminal_cleanup",
              repoRoot,
              runId,
              runPath: path.dirname(workspacePath),
              workspacePath,
            },
            cleanupGuard,
          );
          if (cleanupStatus === "cleaned") {
            status = "cleaned";
          }
        }
      }

      if (runPathExists) {
        for (const runPath of runPaths) {
          if (!(await pathExists(runPath))) {
            continue;
          }
          try {
            if (cleanupGuard) {
              await this.verifyLeaseGuard(cleanupGuard);
            }
            await fs.rm(runPath, { recursive: true, force: true });
            if (cleanupGuard) {
              await this.verifyLeaseGuard(cleanupGuard);
            }
          } catch (error) {
            logger.warn(
              {
                runId,
                runPath,
                error: error instanceof Error ? error.message : String(error),
              },
              "Failed to remove OneShot run workspace directory",
            );
            throw error;
          }
        }
        status = "cleaned";
      }

      if (status === "cleaned") {
        logger.info(
          { runId, runPaths, workspacePaths, repoRoot: lastRepoRoot },
          "Cleaned up OneShot run workspace",
        );
      }

      return status;
    } finally {
      if (cleanupHeartbeatTimer) {
        clearInterval(cleanupHeartbeatTimer);
      }
      if (cleanupLease) {
        await this.config.leaseStore
          ?.releaseLease(cleanupLease.scope, cleanupLease.fencingToken)
          .catch(() => undefined);
      }
      await releaseCleanupRepoLeases();
    }
  }

  private async acquireLeaseWithRetry(
    scope: string,
    ownerTaskArn: string,
    stage: string,
    ttlSeconds: number,
    options: {
      maxWaitMs?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<OneShotWorkspaceLease> {
    if (!this.config.leaseStore) {
      throw new Error("Workspace v2 requires a lease store");
    }
    const startedAt = Date.now();
    const maxWaitMs = options.maxWaitMs ?? 60_000;
    let attempt = 0;
    while (Date.now() - startedAt < maxWaitMs) {
      const lease = await this.config.leaseStore.acquireLease({
        scope,
        ownerTaskArn,
        ownerStage: stage,
        ttlSeconds,
        metadata: { stage },
      });
      if (lease) {
        const waitMs = Date.now() - startedAt;
        const attributes = { scope, stage };
        if (scope.startsWith("repo-cache:")) {
          repoCacheLockWaitHistogram.record(waitMs, attributes);
        } else {
          workspaceLockWaitHistogram.record(waitMs, attributes);
        }
        return lease;
      }
      attempt += 1;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250 * attempt, 2_000)),
      );
    }
    if (scope.startsWith("repo-cache:")) {
      const waitDurationMs = Date.now() - startedAt;
      throw new RepoCacheLeaseTimeoutError(scope, {
        metadata: {
          ...(options.metadata ?? {}),
          waitDurationMs,
          maxWaitMs,
          retryable: true,
        },
      });
    }
    throw new Error(`Timed out acquiring OneShot workspace lease ${scope}`);
  }

  private startLeaseHeartbeat(input: {
    leases: OneShotWorkspaceLease[];
    heartbeatState: LeaseHeartbeatState;
    stage: string;
    runId: number;
    repoName: string;
    ttlSeconds: number;
    intervalSeconds: number;
  }): NodeJS.Timeout {
    const heartbeat = async () => {
      if (input.heartbeatState.lost) {
        return;
      }

      const results: Array<{
        lease: OneShotWorkspaceLease;
        renewed: boolean;
        error?: unknown;
      }> = await Promise.all(
        input.leases.map(async (lease) => {
          try {
            return {
              lease,
              renewed: await this.config.leaseStore!.heartbeatLease(
                lease.scope,
                lease.fencingToken,
                input.ttlSeconds,
              ),
            };
          } catch (error) {
            return { lease, renewed: false, error };
          }
        }),
      );
      const failedResult = results.find((result) => !result.renewed);
      if (!failedResult) {
        input.heartbeatState.consecutiveFailures = 0;
        return;
      }

      if (failedResult.error) {
        await this.recordHeartbeatFailure({
          lease: failedResult.lease,
          heartbeatState: input.heartbeatState,
          stage: input.stage,
          runId: input.runId,
          repoName: input.repoName,
          reason: "heartbeat_error",
          error: failedResult.error,
        });
        return;
      }

      await this.recordHeartbeatFailure({
        lease: failedResult.lease,
        heartbeatState: input.heartbeatState,
        stage: input.stage,
        runId: input.runId,
        repoName: input.repoName,
        reason: "heartbeat_false",
      });
    };

    const timer = setInterval(() => {
      if (input.heartbeatState.lost) {
        clearInterval(timer);
        return;
      }

      heartbeat().catch((error: unknown) => {
        logger.warn(
          {
            runId: input.runId,
            repo: input.repoName,
            stage: input.stage,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to process OneShot workspace lease heartbeat result",
        );
      });
    }, input.intervalSeconds * 1000);
    timer.unref?.();
    return timer;
  }

  private async recordHeartbeatFailure(input: {
    lease: OneShotWorkspaceLease;
    heartbeatState: LeaseHeartbeatState;
    stage: string;
    runId: number;
    repoName: string;
    reason: "heartbeat_false" | "heartbeat_error";
    error?: unknown;
  }): Promise<void> {
    if (input.heartbeatState.lost) {
      return;
    }

    input.heartbeatState.consecutiveFailures += 1;
    leaseHeartbeatFailureCounter.add(1, {
      scope: input.lease.scope,
      stage: input.stage,
      reason: input.reason,
    });

    // Three missed 30s heartbeats fail closed within about 90s by default.
    const thresholdReached =
      input.heartbeatState.consecutiveFailures >=
      LEASE_HEARTBEAT_FAILURE_THRESHOLD;
    if (thresholdReached) {
      input.heartbeatState.lost = true;
    }

    if (thresholdReached && !input.heartbeatState.recordedLost) {
      input.heartbeatState.recordedLost = true;
      await this.config.leaseStore?.recordLeaseLost(
        input.lease.scope,
        input.stage,
        "heartbeat_failed",
      );
    }

    logger.warn(
      {
        runId: input.runId,
        repo: input.repoName,
        stage: input.stage,
        leaseScope: input.lease.scope,
        fencingToken: input.lease.fencingToken,
        consecutiveHeartbeatFailures: input.heartbeatState.consecutiveFailures,
        leaseMarkedLost: input.heartbeatState.lost,
        error:
          input.error instanceof Error
            ? input.error.message
            : input.error
              ? String(input.error)
              : undefined,
      },
      "Failed to heartbeat OneShot workspace lease",
    );
  }

  private async verifyHeldLease(
    lease: OneShotWorkspaceLease,
    stage: string,
    heartbeatState?: LeaseHeartbeatState,
  ): Promise<void> {
    if (heartbeatState?.lost) {
      if (!heartbeatState.recordedLost) {
        heartbeatState.recordedLost = true;
        await this.config.leaseStore?.recordLeaseLost(
          lease.scope,
          stage,
          "heartbeat_failed",
        );
      }
      throw new WorkspaceLeaseLostError(
        `Lost OneShot workspace lease ${lease.scope} token ${lease.fencingToken} after heartbeat failures`,
      );
    }

    const valid = await this.config.leaseStore?.verifyLease(
      lease.scope,
      lease.fencingToken,
    );
    if (!valid) {
      await this.config.leaseStore?.recordLeaseLost(
        lease.scope,
        stage,
        "fencing_token_mismatch",
      );
      throw new WorkspaceLeaseLostError(
        `Lost OneShot workspace lease ${lease.scope} token ${lease.fencingToken}`,
      );
    }
  }

  private async verifyLeaseGuard(guard: LeaseCommandGuard): Promise<void> {
    await this.verifyHeldLease(guard.lease, guard.stage, guard.heartbeatState);
    for (const additionalLease of guard.additionalLeases ?? []) {
      await this.verifyHeldLease(additionalLease, guard.stage);
    }
  }

  private async runRepoGitStep(
    args: string[],
    repoRoot: string,
    context: WorktreeLogContext,
  ): Promise<GitCommandResult> {
    return this.runGitStep(
      this.repoGitArgs(repoRoot, args),
      this.repoGitCwd(repoRoot),
      { ...context, repoRoot },
    );
  }

  private async runRepoGitStepWithLease(
    args: string[],
    repoRoot: string,
    context: WorktreeLogContext,
    guard: LeaseCommandGuard,
  ): Promise<GitCommandResult> {
    await this.verifyLeaseGuard(guard);
    const result = await this.runRepoGitStep(args, repoRoot, context);
    await this.verifyLeaseGuard(guard);
    return result;
  }

  private async runRepoGitQuery(
    args: string[],
    repoRoot: string,
    timeoutMs = GIT_DISCOVERY_TIMEOUT_MS,
  ): Promise<string> {
    return this.runGitQuery(
      this.repoGitArgs(repoRoot, args),
      this.repoGitCwd(repoRoot),
      timeoutMs,
    );
  }

  private async execRepoGitCommand(
    args: string[],
    repoRoot: string,
    timeoutMs = GIT_COMMAND_TIMEOUT_MS,
  ): Promise<GitCommandResult> {
    return this.execGitCommand(
      this.repoGitArgs(repoRoot, args),
      this.repoGitCwd(repoRoot),
      timeoutMs,
    );
  }

  private async runGitStepWithLease(
    args: string[],
    cwd: string,
    context: WorktreeLogContext,
    guard: LeaseCommandGuard,
  ): Promise<GitCommandResult> {
    await this.verifyLeaseGuard(guard);
    const result = await this.runGitStep(args, cwd, { ...context });
    await this.verifyLeaseGuard(guard);
    return result;
  }

  protected async getHeadSha(workspacePath: string): Promise<string> {
    return this.runGitQuery(
      ["rev-parse", "HEAD"],
      workspacePath,
      GIT_DISCOVERY_TIMEOUT_MS,
    );
  }

  private async fetchAdditionalBranch(
    repo: Pick<CodeRepository, "repo_name">,
    repoRoot: string,
    branchName: string,
    baseCommitSha: string | undefined,
    reason: RepoFetchReason,
    guard?: LeaseCommandGuard,
  ): Promise<void> {
    try {
      await this.fetchBranch(
        repo,
        repoRoot,
        branchName,
        baseCommitSha,
        reason,
        guard,
      );
    } catch (error) {
      if (isMissingRemoteBranchFetchError(error)) {
        throw new RetrofitSourceBranchMissingError(branchName, error);
      }
      throw error;
    }
  }

  private repoCacheStatePath(repoRoot: string): string {
    return this.isBareRepoCacheRootPath(repoRoot)
      ? path.join(repoRoot, CACHE_STATE_FILENAME)
      : path.join(repoRoot, ".git", CACHE_STATE_FILENAME);
  }

  private async readRepoCacheState(repoRoot: string): Promise<RepoCacheState> {
    try {
      return parseRepoCacheState(
        await fs.readFile(this.repoCacheStatePath(repoRoot), "utf8"),
      );
    } catch {
      return {};
    }
  }

  private async writeRepoCacheState(
    repoRoot: string,
    state: RepoCacheState,
  ): Promise<void> {
    await fs.writeFile(
      this.repoCacheStatePath(repoRoot),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  }

  private async fetchBranch(
    repo: Pick<CodeRepository, "repo_name">,
    repoRoot: string,
    branchName: string,
    baseCommitSha: string | undefined,
    reason: RepoFetchReason,
    guard?: LeaseCommandGuard,
  ): Promise<{ fetchedAt: Date; remoteHeadSha: string | null }> {
    const args = [
      "fetch",
      "origin",
      "--prune",
      "--no-tags",
      "--refmap=",
      `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
    ];
    const context = {
      action: "git_fetch_branch",
      repo: repo.repo_name,
      repoRoot,
      branchName,
      baseCommitSha,
      reason,
    };
    if (guard) {
      await this.runRepoGitStepWithLease(args, repoRoot, context, guard);
    } else {
      await this.runRepoGitStep(args, repoRoot, context);
    }
    const remoteHeadSha = await this.runRepoGitQuery(
      ["rev-parse", "FETCH_HEAD"],
      repoRoot,
    ).catch(() => null);
    return { fetchedAt: new Date(), remoteHeadSha };
  }

  private async isValidBareRepoRoot(repoRoot: string): Promise<boolean> {
    try {
      return (
        (await this.runRepoGitQuery(
          ["rev-parse", "--is-bare-repository"],
          repoRoot,
        )) === "true"
      );
    } catch {
      return false;
    }
  }

  private async readRepoConfigValues(
    repoRoot: string,
    key: string,
    guard?: LeaseCommandGuard,
  ): Promise<string[]> {
    if (guard) {
      await this.verifyLeaseGuard(guard);
    }
    try {
      const output = await this.runRepoGitQuery(
        ["config", "--get-all", key],
        repoRoot,
      );
      if (guard) {
        await this.verifyLeaseGuard(guard);
      }
      return output.split(/\r?\n/).filter((value) => value.length > 0);
    } catch {
      if (guard) {
        await this.verifyLeaseGuard(guard);
      }
      return [];
    }
  }

  private async normalizeBareRepoCacheRemote(
    repo: Pick<CodeRepository, "repo_name">,
    repoRoot: string,
    guard?: LeaseCommandGuard,
  ): Promise<void> {
    if (!this.isBareRepoCacheRootPath(repoRoot)) {
      return;
    }

    const mirrorValues = await this.readRepoConfigValues(
      repoRoot,
      "remote.origin.mirror",
      guard,
    );
    if (mirrorValues.length > 0) {
      const context = {
        action: "git_config_unset_origin_mirror",
        repo: repo.repo_name,
        repoRoot,
      };
      const args = ["config", "--unset-all", "remote.origin.mirror"];
      if (guard) {
        await this.runRepoGitStepWithLease(args, repoRoot, context, guard);
      } else {
        await this.runRepoGitStep(args, repoRoot, context);
      }
    }

    const fetchValues = await this.readRepoConfigValues(
      repoRoot,
      "remote.origin.fetch",
      guard,
    );
    if (
      fetchValues.length === 1 &&
      fetchValues[0] === REMOTE_TRACKING_FETCH_REFSPEC
    ) {
      return;
    }

    if (fetchValues.length > 0) {
      const context = {
        action: "git_config_unset_origin_fetch",
        repo: repo.repo_name,
        repoRoot,
      };
      const args = ["config", "--unset-all", "remote.origin.fetch"];
      if (guard) {
        await this.runRepoGitStepWithLease(args, repoRoot, context, guard);
      } else {
        await this.runRepoGitStep(args, repoRoot, context);
      }
    }

    const context = {
      action: "git_config_set_origin_fetch",
      repo: repo.repo_name,
      repoRoot,
    };
    const args = [
      "config",
      "--add",
      "remote.origin.fetch",
      REMOTE_TRACKING_FETCH_REFSPEC,
    ];
    if (guard) {
      await this.runRepoGitStepWithLease(args, repoRoot, context, guard);
    } else {
      await this.runRepoGitStep(args, repoRoot, context);
    }
  }

  private async ensureMirrorRepo(
    repo: Pick<CodeRepository, "repo_name" | "repo_url">,
    repoRoot: string,
    guard?: LeaseCommandGuard,
  ): Promise<boolean> {
    const repoParent = path.dirname(repoRoot);
    await fs.mkdir(repoParent, { recursive: true });

    if (await pathExists(repoRoot)) {
      if (await this.isValidBareRepoRoot(repoRoot)) {
        await this.normalizeBareRepoCacheRemote(repo, repoRoot, guard);
        return false;
      }
      logger.warn(
        {
          repo: repo.repo_name,
          repoRoot,
        },
        "Removing invalid OneShot repository mirror before recloning",
      );
      if (guard) {
        await this.verifyLeaseGuard(guard);
      }
      await fs.rm(repoRoot, { recursive: true, force: true });
      if (guard) {
        await this.verifyLeaseGuard(guard);
      }
    }

    const authUrl = await buildAuthenticatedRepoUrl(repo);
    const startedAt = Date.now();
    const tempRoot = path.join(
      repoParent,
      `${path.basename(repoRoot, ".git")}.tmp-${process.pid}-${Date.now()}.git`,
    );
    await fs.rm(tempRoot, { recursive: true, force: true });

    try {
      const cloneContext = {
        action: "git_clone_mirror",
        repo: repo.repo_name,
        repoRoot,
        mirrorTempPath: tempRoot,
      };
      if (guard) {
        await this.runGitStepWithLease(
          ["clone", "--mirror", authUrl, tempRoot],
          repoParent,
          cloneContext,
          guard,
        );
      } else {
        await this.runGitStep(
          ["clone", "--mirror", authUrl, tempRoot],
          repoParent,
          cloneContext,
        );
      }
      if (!(await this.isValidBareRepoRoot(tempRoot))) {
        throw new Error(
          `Cloned mirror ${tempRoot} is not a valid bare repository`,
        );
      }
      await this.normalizeBareRepoCacheRemote(repo, tempRoot, guard);
      if (guard) {
        await this.verifyLeaseGuard(guard);
      }
      await fs.rename(tempRoot, repoRoot);
      if (guard) {
        await this.verifyLeaseGuard(guard);
      }
      const durationMs = Date.now() - startedAt;
      repoCacheColdHydrationDurationHistogram.record(durationMs, {
        repo_name: repo.repo_name,
      });
      logger.info(
        {
          repo: repo.repo_name,
          repoRoot,
          durationMs,
        },
        "Cloned OneShot repository mirror",
      );
      return true;
    } catch (error) {
      await fs
        .rm(tempRoot, { recursive: true, force: true })
        .catch(() => undefined);
      throw error;
    }
  }

  protected async ensureHydratedRepoForPinnedWorkspace(
    repo: Pick<CodeRepository, "repo_name" | "repo_url">,
    baseCommitSha?: string,
    branchName?: string,
    guard?: LeaseCommandGuard,
    branchFetchPolicy: RepoBranchFetchPolicy = "freshness_required",
  ): Promise<HydratedRepo> {
    const repoRoot = this.repoMirrorRoot(repo.repo_name);
    const authUrl = await buildAuthenticatedRepoUrl(repo);
    const freshnessTtlMs = this.config.repoCacheFreshnessTtlMs ?? 300_000;

    if (await this.ensureMirrorRepo(repo, repoRoot, guard)) {
      let lastRepoFetchAt: Date | null = new Date();
      let lastRemoteHeadSha: string | null = null;
      const hasClonedCommitLocally = baseCommitSha
        ? await this.hasCommit(repoRoot, baseCommitSha)
        : false;
      const canUseLocalCandidateSha =
        branchFetchPolicy === "candidate_sha_authoritative" &&
        hasClonedCommitLocally;
      if (branchName && !canUseLocalCandidateSha) {
        const fetchResult = await this.fetchBranch(
          repo,
          repoRoot,
          branchName,
          baseCommitSha,
          "clone",
          guard,
        );
        lastRepoFetchAt = fetchResult.fetchedAt;
        lastRemoteHeadSha = fetchResult.remoteHeadSha;
        await this.writeRepoCacheState(repoRoot, {
          branches: {
            [branchName]: {
              lastFetchAt: lastRepoFetchAt.toISOString(),
              remoteHeadSha: lastRemoteHeadSha,
            },
          },
        });
      }
      return {
        repoRoot,
        lastRepoFetchAt,
        lastRemoteHeadSha,
        fetchReason: canUseLocalCandidateSha ? "candidate_sha_local" : "clone",
      };
    }

    const remoteSetUrlContext = {
      action: "git_remote_set_url",
      repo: repo.repo_name,
      repoRoot,
    };
    const remoteSetUrl = guard
      ? this.runRepoGitStepWithLease(
          ["remote", "set-url", "origin", authUrl],
          repoRoot,
          remoteSetUrlContext,
          guard,
        )
      : this.runRepoGitStep(
          ["remote", "set-url", "origin", authUrl],
          repoRoot,
          remoteSetUrlContext,
        );
    await remoteSetUrl.catch((error: unknown) => {
      if (error instanceof WorkspaceLeaseLostError) {
        throw error;
      }
      return undefined;
    });

    const hasCommitLocally = baseCommitSha
      ? await this.hasCommit(repoRoot, baseCommitSha)
      : false;

    if (!branchName) {
      if (!hasCommitLocally) {
        const fetchAllContext = {
          action: "git_fetch_all",
          repo: repo.repo_name,
          repoRoot,
          baseCommitSha,
          reason: "unscoped_fetch",
        };
        if (guard) {
          await this.runRepoGitStepWithLease(
            ["fetch", "--all", "--prune"],
            repoRoot,
            fetchAllContext,
            guard,
          );
        } else {
          await this.runRepoGitStep(
            ["fetch", "--all", "--prune"],
            repoRoot,
            fetchAllContext,
          );
        }
        const fetchedAt = new Date();
        if (baseCommitSha && !(await this.hasCommit(repoRoot, baseCommitSha))) {
          throw new Error(
            `Required commit ${baseCommitSha} is not available locally for repository ${repo.repo_name}`,
          );
        }
        return {
          repoRoot,
          lastRepoFetchAt: fetchedAt,
          lastRemoteHeadSha: undefined,
          fetchReason: "unscoped_fetch",
        };
      }
      return {
        repoRoot,
        lastRepoFetchAt: null,
        lastRemoteHeadSha: undefined,
        fetchReason: "fresh_cache",
      };
    }

    const cacheState = await this.readRepoCacheState(repoRoot);
    const branchCache = cacheState.branches?.[branchName];
    if (
      branchFetchPolicy === "candidate_sha_authoritative" &&
      hasCommitLocally
    ) {
      logger.info(
        {
          repo: repo.repo_name,
          repoRoot,
          baseCommitSha,
          branchName,
        },
        "Skipping git fetch because candidate SHA exists in the repo cache",
      );
      return {
        repoRoot,
        lastRepoFetchAt: branchCache?.lastFetchAt
          ? new Date(branchCache.lastFetchAt)
          : null,
        lastRemoteHeadSha: branchCache?.remoteHeadSha,
        fetchReason: "candidate_sha_local",
      };
    }
    const cacheFresh = cacheEntryIsFresh(branchCache, freshnessTtlMs);
    const fetchReason: RepoFetchReason | null = !hasCommitLocally
      ? "missing_required_sha"
      : !branchCache
        ? "missing_cache_state"
        : !cacheFresh
          ? "stale_cache"
          : null;

    if (fetchReason) {
      const fetchResult = await this.fetchBranch(
        repo,
        repoRoot,
        branchName,
        baseCommitSha,
        fetchReason,
        guard,
      );
      const nextState: RepoCacheState = {
        ...cacheState,
        branches: {
          ...(cacheState.branches ?? {}),
          [branchName]: {
            lastFetchAt: fetchResult.fetchedAt.toISOString(),
            remoteHeadSha: fetchResult.remoteHeadSha,
          },
        },
      };
      await this.writeRepoCacheState(repoRoot, nextState);
      if (baseCommitSha && !(await this.hasCommit(repoRoot, baseCommitSha))) {
        throw new Error(
          `Required commit ${baseCommitSha} is not available locally for repository ${repo.repo_name}`,
        );
      }
      return {
        repoRoot,
        lastRepoFetchAt: fetchResult.fetchedAt,
        lastRemoteHeadSha: fetchResult.remoteHeadSha,
        fetchReason,
      };
    }

    logger.info(
      {
        repo: repo.repo_name,
        repoRoot,
        baseCommitSha,
        branchName,
        lastRepoFetchAt: branchCache.lastFetchAt,
      },
      "Skipping git fetch because required commit exists and repo cache is fresh",
    );

    return {
      repoRoot,
      lastRepoFetchAt: new Date(branchCache.lastFetchAt),
      lastRemoteHeadSha: branchCache.remoteHeadSha,
      fetchReason: "fresh_cache",
    };
  }

  protected async ensureHydratedRepo(
    repo: Pick<CodeRepository, "repo_name" | "repo_url">,
    baseCommitSha?: string,
    branchName?: string,
  ): Promise<string> {
    const repoRoot = this.repoMirrorRoot(repo.repo_name);
    const authUrl = await buildAuthenticatedRepoUrl(repo);

    await this.ensureMirrorRepo(repo, repoRoot);

    await this.runRepoGitStep(
      ["remote", "set-url", "origin", authUrl],
      repoRoot,
      {
        action: "git_remote_set_url",
        repo: repo.repo_name,
        repoRoot,
      },
    ).catch(() => undefined);

    const hasCommitLocally = baseCommitSha
      ? await this.hasCommit(repoRoot, baseCommitSha)
      : false;

    if (!hasCommitLocally) {
      if (branchName) {
        await this.fetchBranch(
          repo,
          repoRoot,
          branchName,
          baseCommitSha,
          "missing_required_sha",
        );
      } else {
        await this.runRepoGitStep(["fetch", "--all", "--prune"], repoRoot, {
          action: "git_fetch_all",
          repo: repo.repo_name,
          repoRoot,
          baseCommitSha,
        });
      }
    } else {
      logger.info(
        {
          repo: repo.repo_name,
          repoRoot,
          baseCommitSha,
        },
        "Skipping git fetch because required commit already exists locally",
      );
    }

    if (baseCommitSha && !(await this.hasCommit(repoRoot, baseCommitSha))) {
      throw new Error(
        `Required commit ${baseCommitSha} is not available locally for repository ${repo.repo_name}`,
      );
    }

    return repoRoot;
  }

  protected async tryReuseWorktree(
    repoRoot: string,
    workspacePath: string,
    baseCommitSha: string,
    context: WorktreeLogContext,
  ): Promise<boolean> {
    if (!(await pathExists(workspacePath))) {
      return false;
    }

    try {
      await this.runGitStep(["rev-parse", "--show-toplevel"], workspacePath, {
        ...context,
        action: "git_worktree_validate",
      });
      await this.runGitStep(["reset", "--hard", baseCommitSha], workspacePath, {
        ...context,
        action: "git_reset_hard",
      });
      await this.runGitStep(["clean", "-ffd"], workspacePath, {
        ...context,
        action: "git_clean",
      });
      logger.info(
        {
          ...context,
        },
        "Reused existing OneShot workspace",
      );
      return true;
    } catch (error) {
      logger.warn(
        {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to reuse OneShot workspace, falling back to recreation",
      );
      await this.cleanupWorktree(repoRoot, workspacePath, {
        ...context,
        action: "git_worktree_recovery",
      });
      return false;
    }
  }

  protected async cleanupStageState(
    statePath: string,
    stage: string,
  ): Promise<void> {
    await fs
      .rm(path.join(statePath, stage), {
        recursive: true,
        force: true,
      })
      .catch(() => undefined);
  }

  private async repoCommonGitDir(repoRoot: string): Promise<string> {
    const commonGitDir = await this.runRepoGitQuery(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      repoRoot,
      GIT_DISCOVERY_TIMEOUT_MS,
    );
    return path.resolve(commonGitDir);
  }

  private async findWorktreeAdminDirsForPath(
    repoRoot: string,
    workspacePath: string,
  ): Promise<string[]> {
    const commonGitDir = await this.repoCommonGitDir(repoRoot);
    const worktreesDir = path.join(commonGitDir, "worktrees");
    const entries = await fs
      .readdir(worktreesDir, { withFileTypes: true })
      .catch(() => []);
    const adminDirs: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const adminDir = path.join(worktreesDir, entry.name);
      const rawGitDir = await fs
        .readFile(path.join(adminDir, "gitdir"), "utf8")
        .catch(() => null);
      if (!rawGitDir) {
        continue;
      }
      const gitDirPath = rawGitDir.trim();
      const absoluteGitDirPath = path.isAbsolute(gitDirPath)
        ? gitDirPath
        : path.resolve(adminDir, gitDirPath);
      const registeredWorkspacePath =
        path.basename(absoluteGitDirPath) === ".git"
          ? path.dirname(absoluteGitDirPath)
          : absoluteGitDirPath;

      if (pathsReferToSameLocation(registeredWorkspacePath, workspacePath)) {
        adminDirs.push(adminDir);
      }
    }

    return adminDirs;
  }

  private async removeWorktreeAdminDirsForPath(
    repoRoot: string,
    workspacePath: string,
    context: WorktreeLogContext,
    guard?: LeaseCommandGuard,
  ): Promise<number> {
    const adminDirs = await this.findWorktreeAdminDirsForPath(
      repoRoot,
      workspacePath,
    );
    for (const adminDir of adminDirs) {
      if (guard) {
        await this.verifyLeaseGuard(guard);
      }
      await fs.rm(adminDir, { recursive: true, force: true });
      if (guard) {
        await this.verifyLeaseGuard(guard);
      }
      logger.info(
        {
          ...context,
          repoRoot,
          workspacePath,
          worktreeAdminDir: adminDir,
        },
        "Removed stale OneShot worktree admin registration",
      );
    }
    return adminDirs.length;
  }

  protected async cleanupWorktree(
    repoRoot: string,
    workspacePath: string,
    context: WorktreeLogContext,
    guard?: LeaseCommandGuard,
  ): Promise<CleanupRunWorkspaceStatus> {
    const runGit = async (
      args: string[],
      targetRepoRoot: string,
      gitContext: WorktreeLogContext,
      options: { catchErrors?: boolean } = {},
    ) => {
      const execute = guard
        ? this.runRepoGitStepWithLease(args, targetRepoRoot, gitContext, guard)
        : this.runRepoGitStep(args, targetRepoRoot, gitContext);
      if (options.catchErrors) {
        await execute.catch(() => undefined);
        return;
      }
      await execute;
    };

    const workspaceExists = await pathExists(workspacePath);
    let registeredEntry = await this.findRegisteredWorktree(
      repoRoot,
      workspacePath,
    );
    if (!workspaceExists && !registeredEntry) {
      return "not_found";
    }

    const worktreeRegistrationPath =
      registeredEntry?.worktreePath ?? workspacePath;

    if (registeredEntry?.lockedReason) {
      logger.warn(
        {
          ...context,
          workspacePath,
          lockedReason: registeredEntry.lockedReason,
        },
        "Found locked OneShot worktree registration during cleanup",
      );
      await runGit(
        ["worktree", "unlock", worktreeRegistrationPath],
        repoRoot,
        {
          ...context,
          action: `${context.action ?? "git_worktree"}_unlock`,
        },
        { catchErrors: true },
      );
    }

    await runGit(
      ["worktree", "remove", "--force", worktreeRegistrationPath],
      repoRoot,
      {
        ...context,
        action: `${context.action ?? "git_worktree"}_remove`,
      },
      { catchErrors: true },
    );

    registeredEntry = await this.findRegisteredWorktree(
      repoRoot,
      workspacePath,
    );
    if (registeredEntry) {
      await this.removeWorktreeAdminDirsForPath(
        repoRoot,
        workspacePath,
        {
          ...context,
          action: `${context.action ?? "git_worktree"}_admin_remove`,
        },
        guard,
      );
    }

    if (guard) {
      await this.verifyLeaseGuard(guard);
    }
    await fs
      .rm(workspacePath, { recursive: true, force: true })
      .catch(() => undefined);
    if (guard) {
      await this.verifyLeaseGuard(guard);
    }

    registeredEntry = await this.findRegisteredWorktree(
      repoRoot,
      workspacePath,
    );
    if (registeredEntry) {
      throw new Error(
        `Worktree registration for ${workspacePath} still exists after cleanup` +
          (registeredEntry.lockedReason
            ? ` (${registeredEntry.lockedReason})`
            : ""),
      );
    }

    if (await pathExists(workspacePath)) {
      throw new Error(
        `Worktree path ${workspacePath} still exists after cleanup`,
      );
    }

    return "cleaned";
  }

  protected async resolveRepoRootForWorkspace(
    workspacePath: string,
  ): Promise<string | null> {
    const repoRootFromWorkspace =
      await this.resolveRepoRootFromWorkspacePath(workspacePath);
    if (repoRootFromWorkspace) {
      return repoRootFromWorkspace;
    }

    return this.findRepoRootByRegisteredWorktree(workspacePath);
  }

  protected async resolveRepoRootFromWorkspacePath(
    workspacePath: string,
  ): Promise<string | null> {
    if (!(await pathExists(workspacePath))) {
      return null;
    }

    try {
      const commonGitDir = await this.runGitQuery(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        workspacePath,
        GIT_DISCOVERY_TIMEOUT_MS,
      );

      if (commonGitDir) {
        const normalizedCommonGitDir = path.resolve(commonGitDir);
        if (path.basename(normalizedCommonGitDir) === ".git") {
          return path.dirname(normalizedCommonGitDir);
        }
        if (await this.isValidBareRepoRoot(normalizedCommonGitDir)) {
          return normalizedCommonGitDir;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  protected async findRepoRootByRegisteredWorktree(
    workspacePath: string,
  ): Promise<string | null> {
    if (!(await pathExists(this.repoCacheBasePath))) {
      return null;
    }

    const entries = await fs.readdir(this.repoCacheBasePath, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const repoRoot = path.join(this.repoCacheBasePath, entry.name);
      const isRepoRoot =
        (await pathExists(path.join(repoRoot, ".git"))) ||
        (await this.isValidBareRepoRoot(repoRoot));
      if (!isRepoRoot) {
        continue;
      }

      try {
        const registeredEntry = await this.findRegisteredWorktree(
          repoRoot,
          workspacePath,
        );
        if (registeredEntry) {
          return repoRoot;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  protected repoCacheScopeForRepoRoot(repoRoot: string): string {
    const relative = path.relative(this.repoCacheBasePath, repoRoot);
    const rawRepoName =
      relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? relative.split(path.sep).join("/")
        : path.basename(repoRoot);
    const repoName = rawRepoName.endsWith(".git")
      ? rawRepoName.slice(0, -".git".length)
      : rawRepoName;
    return `repo-cache:${repoName}`;
  }

  protected async findRegisteredWorktree(
    repoRoot: string,
    workspacePath: string,
  ): Promise<GitWorktreeEntry | null> {
    const worktrees = await this.listWorktrees(repoRoot);
    return (
      worktrees.find((entry) =>
        pathsReferToSameLocation(entry.worktreePath, workspacePath),
      ) ?? null
    );
  }

  protected async listWorktrees(repoRoot: string): Promise<GitWorktreeEntry[]> {
    const stdout = await this.runRepoGitQuery(
      ["worktree", "list", "--porcelain"],
      repoRoot,
      GIT_DISCOVERY_TIMEOUT_MS,
    );
    return parseGitWorktreeList(stdout);
  }

  protected async runGitQuery(
    args: string[],
    cwd: string,
    timeoutMs = GIT_DISCOVERY_TIMEOUT_MS,
  ): Promise<string> {
    const result = await this.execGitCommand(args, cwd, timeoutMs);
    return result.stdout.trim();
  }

  protected async execGitCommand(
    args: string[],
    cwd: string,
    timeoutMs = GIT_COMMAND_TIMEOUT_MS,
  ): Promise<GitCommandResult> {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  protected async hasCommit(
    repoRoot: string,
    commitSha: string,
  ): Promise<boolean> {
    try {
      await this.execRepoGitCommand(
        ["cat-file", "-e", `${commitSha}^{commit}`],
        repoRoot,
        GIT_DISCOVERY_TIMEOUT_MS,
      );
      return true;
    } catch {
      return false;
    }
  }

  protected async runGitStep(
    args: string[],
    cwd: string,
    context: Record<string, unknown>,
  ): Promise<GitCommandResult> {
    const startedAt = Date.now();
    const command = formatGitCommandForLog(args);
    logger.info(
      {
        ...context,
        cwd,
        command,
      },
      "Starting OneShot git step",
    );

    try {
      const result = await this.execGitCommand(args, cwd);

      logger.info(
        {
          ...context,
          cwd,
          command,
          durationMs: Date.now() - startedAt,
        },
        "Completed OneShot git step",
      );

      return result;
    } catch (error) {
      const execError = error as ExecFileException & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };

      logger.error(
        {
          ...context,
          cwd,
          command,
          durationMs: Date.now() - startedAt,
          error: redactGitText(execError.message),
          code: execError.code ?? null,
          signal: execError.signal ?? null,
          killed: execError.killed ?? false,
          stdoutTail: getLogTail(execError.stdout),
          stderrTail: getLogTail(execError.stderr),
        },
        "OneShot git step failed",
      );
      if (
        isWorktreeAddGitArgs(args) &&
        (execError.killed || execError.signal || execError.code === null)
      ) {
        throw new WorkspaceCheckoutTimeoutError(
          `workspace_checkout_timeout: git worktree add failed or timed out for ${String(context.workspacePath ?? "workspace")}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

export function createLeasedOneShotWorkspaceManager(
  oneShotDb: OneShotDatabase,
  config: {
    repoBasePath: string;
    repoCacheBasePath?: string;
    workspaceBasePath: string;
    worktreeBasePath?: string;
    leaseOwnerTaskArn?: string;
    leaseTtlSeconds?: number;
    leaseHeartbeatSeconds?: number;
    repoCacheFreshnessTtlMs?: number;
  },
): OneShotWorkspaceManager {
  return new OneShotWorkspaceManager({
    repoBasePath: config.repoBasePath,
    repoCacheBasePath: config.repoCacheBasePath,
    workspaceBasePath: config.workspaceBasePath,
    worktreeBasePath: config.worktreeBasePath,
    leaseStore: oneShotDb.workspaceLeases,
    workspaceStateStore: oneShotDb.workspaceState,
    leaseOwnerTaskArn: config.leaseOwnerTaskArn,
    leaseTtlSeconds: config.leaseTtlSeconds,
    leaseHeartbeatSeconds: config.leaseHeartbeatSeconds,
    repoCacheFreshnessTtlMs: config.repoCacheFreshnessTtlMs,
  });
}
