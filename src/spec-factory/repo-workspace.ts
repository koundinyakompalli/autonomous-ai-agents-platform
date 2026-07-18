import * as path from "path";
import {
  accessSync,
  constants,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { deregisterRepo } from "../claude-sdk/config.js";
import { registerRepoFromPath as defaultRegisterRepoFromPath } from "../claude-sdk/index.js";
import type { CodeRepository } from "../orchestrator/database.js";
import {
  isMissingRemoteBranchFetchError,
  OneShotWorkspaceManager,
  type PreparedBranchWorkspace,
} from "../oneshot/workspaces.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("spec-factory-repo-workspace");
const BRANCHES_BY_PREFERENCE = ["master", "main"] as const;

export const DEFAULT_SPEC_FACTORY_REPO_CACHE_BASE =
  "/mnt/efs/specter-repo/spec-factory/repo-cache";
export const DEFAULT_SPEC_FACTORY_WORKSPACE_BASE =
  "/mnt/efs/specter-repo/spec-factory/workspaces";
export const DEFAULT_SPEC_FACTORY_WORKTREE_BASE =
  "/var/spec-factory/workspaces";
export const DEFAULT_SPEC_FACTORY_REPO_CACHE_FRESHNESS_TTL_MS = 300_000;

export type SpecFactoryRepoGroundingBranch = "master" | "main";

export interface SpecFactoryRepoWorkspace {
  repoName: string;
  branch: SpecFactoryRepoGroundingBranch;
  headSha: string;
  repoRoot: string;
  workspacePath: string;
  repoId?: string;
  cleanup?: () => Promise<void>;
}

export interface SpecFactoryBranchWorkspaceProvider {
  prepareBranchWorkspace(input: {
    runId: number;
    repo: Pick<CodeRepository, "repo_name" | "repo_url">;
    branchName: SpecFactoryRepoGroundingBranch;
    stage: "planner";
    branchFetchPolicy: "freshness_required";
  }): Promise<PreparedBranchWorkspace>;
}

interface SpecFactoryRepoWorkspaceManagerOptions {
  repoCacheBase?: string;
  workspaceBase?: string;
  worktreeBase?: string;
  repoCacheFreshnessTtlMs?: number;
  registerRepoFromPath?: (repoPath: string, explicitId?: string) => string;
  workspaceProviderFactory?: (input: {
    sourceId: number;
    repoName: string;
  }) => SpecFactoryBranchWorkspaceProvider;
}

function positiveIntegerEnv(
  name: string,
  fallback: number | undefined = undefined,
): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeRepoName(repoName: string): string {
  const normalized = repoName.trim();
  if (!normalized) throw new Error("Spec Factory repo_name is required");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("..") ||
    /[\x00-\x1F\x7F]/.test(normalized)
  ) {
    throw new Error(`Invalid Spec Factory repo_name: ${repoName}`);
  }
  return normalized;
}

export function assertSpecFactoryRepoCacheReady(repoCacheBase: string): void {
  const base = repoCacheBase.trim();
  if (!base) {
    throw new Error("SPEC_FACTORY_REPO_CACHE_BASE is required");
  }
  try {
    mkdirSync(base, { recursive: true });
    accessSync(base, constants.W_OK);
    const probe = path.join(
      base,
      `.spec-factory-repo-cache-probe-${process.pid}-${Date.now()}`,
    );
    writeFileSync(probe, "ok", { encoding: "utf8", flag: "wx" });
    unlinkSync(probe);
  } catch (error) {
    throw new Error(`SPEC_FACTORY_REPO_CACHE_BASE ${base} must be writable`, {
      cause: error,
    });
  }
}

function registrationId(sourceId: number, repoName: string): string {
  return `spec-factory-source-${sourceId}-${repoName.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

export class SpecFactoryRepoWorkspaceManager {
  readonly repoCacheBase: string;
  readonly workspaceBase: string;
  readonly worktreeBase: string;
  readonly repoCacheFreshnessTtlMs: number;
  private readonly registerRepoFromPath: (
    repoPath: string,
    explicitId?: string,
  ) => string;
  private readonly workspaceProviderFactory: (input: {
    sourceId: number;
    repoName: string;
  }) => SpecFactoryBranchWorkspaceProvider;

  constructor(options: SpecFactoryRepoWorkspaceManagerOptions = {}) {
    this.repoCacheBase =
      options.repoCacheBase ||
      process.env.SPEC_FACTORY_REPO_CACHE_BASE ||
      DEFAULT_SPEC_FACTORY_REPO_CACHE_BASE;
    this.workspaceBase =
      options.workspaceBase ||
      process.env.SPEC_FACTORY_WORKSPACE_BASE ||
      DEFAULT_SPEC_FACTORY_WORKSPACE_BASE;
    this.worktreeBase =
      options.worktreeBase ||
      process.env.SPEC_FACTORY_WORKTREE_BASE ||
      DEFAULT_SPEC_FACTORY_WORKTREE_BASE;
    this.repoCacheFreshnessTtlMs =
      options.repoCacheFreshnessTtlMs ??
      positiveIntegerEnv(
        "SPEC_FACTORY_REPO_CACHE_FRESHNESS_TTL_MS",
        positiveIntegerEnv(
          "ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS",
          DEFAULT_SPEC_FACTORY_REPO_CACHE_FRESHNESS_TTL_MS,
        ),
      )!;
    this.registerRepoFromPath =
      options.registerRepoFromPath || defaultRegisterRepoFromPath;
    this.workspaceProviderFactory =
      options.workspaceProviderFactory ||
      ((input) =>
        new OneShotWorkspaceManager({
          repoBasePath: this.repoCacheBase,
          repoCacheBasePath: this.repoCacheBase,
          workspaceBasePath: path.join(this.workspaceBase, input.repoName),
          worktreeBasePath: path.join(this.worktreeBase, input.repoName),
          repoCacheFreshnessTtlMs: this.repoCacheFreshnessTtlMs,
        }));
  }

  // API name is kept stable for Task 4 callers; it now means "prepare the
  // preferred default branch workspace", using master first and main second.
  async prepareMasterWorkspace(input: {
    sourceId: number;
    repo: Pick<CodeRepository, "repo_name" | "repo_url">;
  }): Promise<SpecFactoryRepoWorkspace> {
    const repoName = normalizeRepoName(input.repo.repo_name);
    const provider = this.workspaceProviderFactory({
      sourceId: input.sourceId,
      repoName,
    });
    const errors: string[] = [];

    for (const branch of BRANCHES_BY_PREFERENCE) {
      try {
        logger.info(
          {
            sourceId: input.sourceId,
            repoName,
            branch,
            repoCacheBase: this.repoCacheBase,
            workspaceBase: this.workspaceBase,
            worktreeBase: this.worktreeBase,
          },
          "Preparing Spec Factory repo workspace through OneShot cache manager",
        );
        const workspace = await provider.prepareBranchWorkspace({
          runId: input.sourceId,
          repo: input.repo,
          branchName: branch,
          stage: "planner",
          branchFetchPolicy: "freshness_required",
        });
        const repoId = this.registerRepoFromPath(
          workspace.workspacePath,
          registrationId(input.sourceId, repoName),
        );

        logger.info(
          {
            sourceId: input.sourceId,
            repoName,
            branch,
            headSha: workspace.headSha,
            workspacePath: workspace.workspacePath,
            repoFetchReason: workspace.repoFetchReason,
            reused: workspace.reused,
          },
          "Prepared Spec Factory repo workspace",
        );

        return {
          repoName,
          branch,
          headSha: workspace.headSha,
          repoRoot: workspace.repoRoot,
          workspacePath: workspace.workspacePath,
          repoId,
          cleanup: async () => {
            if (repoId) {
              deregisterRepo(repoId);
            }
            await workspace.cleanup();
          },
        };
      } catch (error) {
        if (!isMissingRemoteBranchFetchError(error)) throw error;
        errors.push(
          `${branch}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new Error(
      `Neither origin/master nor origin/main exists for ${repoName}; Spec Factory only uses master or main (${errors.join("; ")})`,
    );
  }
}
