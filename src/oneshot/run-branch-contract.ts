import type { Logger } from "pino";
import type { CodeRepository } from "../orchestrator/database.js";
import type { OneShotDatabase } from "./database/index.js";
import {
  createRemoteBranchIfMissing,
  getRemoteBranchHead,
  isAncestor,
} from "./git.js";
import {
  buildImplementationBranchName,
  isSharedEpicImplementationBranchName,
  resolveRunBranchBaseSha,
  resolveRunBranchName,
} from "./implementation-branch.js";
import type { OneShotRun } from "./types.js";
import type { OneShotStage, OneShotWorkspaceManager } from "./workspaces.js";

export interface RunBranchContract {
  branchName: string;
  baseCommitSha: string;
  expectedHeadSha: string;
  workspaceBaseSha: string;
  currentCandidateSha: string | null;
  remoteHeadSha: string | null;
  repairedMetadata: boolean;
  createdRemoteBranch: boolean;
  sharedEpicBranch: boolean;
}

function isCandidatePinnedStage(stage: OneShotStage | "qualification"): boolean {
  return stage === "code-reviewer" || stage === "tester";
}

function canNormalizePrePlanningSharedEpicBranch(input: {
  run: OneShotRun;
  stage: OneShotStage | "qualification";
  branchName: string;
  currentCandidateSha: string | null;
}): boolean {
  return (
    input.stage === "planner" &&
    isSharedEpicImplementationBranchName(input.branchName) &&
    input.run.current_plan_version === null &&
    input.run.current_review_version === null &&
    input.run.current_implementation_version === null &&
    input.run.current_implementation_commit_sha === null &&
    input.currentCandidateSha === null &&
    input.run.current_code_review_version === null &&
    input.run.current_test_version === null &&
    input.run.current_pr_url === null
  );
}

export async function ensureRunBranchContract(input: {
  run: OneShotRun;
  repo: CodeRepository;
  oneShotDb: OneShotDatabase;
  workspaceManager: OneShotWorkspaceManager;
  stage: OneShotStage | "qualification";
  logger: Logger;
}): Promise<RunBranchContract> {
  const currentCandidate = await input.oneShotDb.candidateVersions.getCurrentCandidate(
    input.run.id,
  );
  const storedBranchName = resolveRunBranchName(input.run);
  const normalizedSharedEpicBranch = canNormalizePrePlanningSharedEpicBranch({
    run: input.run,
    stage: input.stage,
    branchName: storedBranchName,
    currentCandidateSha: currentCandidate?.candidateCommitSha ?? null,
  });
  const branchName = normalizedSharedEpicBranch
    ? buildImplementationBranchName(input.run.jira_key, input.run.id)
    : storedBranchName;
  const baseCommitSha = normalizedSharedEpicBranch
    ? input.run.base_commit_sha
    : resolveRunBranchBaseSha(input.run);
  const sharedEpicBranch = isSharedEpicImplementationBranchName(branchName);
  const expectedHeadSha =
    currentCandidate?.candidateCommitSha ??
    input.run.current_implementation_commit_sha ??
    baseCommitSha;
  const metadataMissing =
    input.run.run_branch_name !== branchName ||
    input.run.run_branch_base_sha !== baseCommitSha ||
    input.run.run_branch_created_at === null ||
    input.run.current_implementation_branch !== branchName;

  if (metadataMissing) {
    await input.oneShotDb.runs.ensureRunBranchContract({
      runId: input.run.id,
      branchName,
      baseCommitSha,
    });
  }

  const remoteHead = await getRemoteBranchHead(input.repo, branchName);
  if (remoteHead) {
    const canReuseAdvancedEpicBranch =
      sharedEpicBranch &&
      !currentCandidate?.candidateCommitSha &&
      !input.run.current_implementation_commit_sha;
    const canUseCandidatePinnedSharedBranch =
      sharedEpicBranch &&
      isCandidatePinnedStage(input.stage) &&
      Boolean(
        currentCandidate?.candidateCommitSha ||
          input.run.current_implementation_commit_sha,
      );
    if (
      remoteHead.headSha !== expectedHeadSha &&
      !canReuseAdvancedEpicBranch &&
      !canUseCandidatePinnedSharedBranch
    ) {
      throw new Error(
        `Remote run branch ${branchName} exists at ${remoteHead.headSha}; expected ${expectedHeadSha}`,
      );
    }
    if (remoteHead.headSha !== expectedHeadSha && canReuseAdvancedEpicBranch) {
      const workspace = await input.workspaceManager.prepareImplementerWorkspace(
        input.run.id,
        input.repo,
        remoteHead.headSha,
        branchName,
      );
      try {
        const targetBaseIsAncestor = await isAncestor(
          workspace.workspacePath,
          baseCommitSha,
          remoteHead.headSha,
        );
        if (!targetBaseIsAncestor) {
          throw new Error(
            `Remote Epic branch ${branchName} exists at ${remoteHead.headSha}, which is not a descendant of target base ${baseCommitSha}`,
          );
        }
      } finally {
        await workspace.cleanup().catch((error: unknown) => {
          input.logger.warn(
            {
              runId: input.run.id,
              jiraKey: input.run.jira_key,
              repoName: input.repo.repo_name,
              workspacePath: workspace.workspacePath,
              error: error instanceof Error ? error.message : String(error),
            },
            "Advanced Epic run branch ancestry workspace cleanup failed",
          );
          return undefined;
        });
      }
    }
    const workspaceBaseSha =
      remoteHead.headSha !== expectedHeadSha && canReuseAdvancedEpicBranch
        ? remoteHead.headSha
        : expectedHeadSha;
    await input.oneShotDb.events.createEvent({
      oneshot_run_id: input.run.id,
      event_type: metadataMissing ? "run_branch_repaired" : "run_branch_reused",
      from_state: input.run.state,
      to_state: input.run.state,
      stage: input.stage,
      metadata_json: {
        repoId: input.repo.id,
        repoName: input.repo.repo_name,
        targetBranchName: input.run.branch_name,
        runBranchName: branchName,
        runBranchBaseSha: baseCommitSha,
        expectedHeadSha,
        workspaceBaseSha,
        currentCandidateSha: currentCandidate?.candidateCommitSha ?? null,
        remoteHeadSha: remoteHead.headSha,
        repairedMetadata: metadataMissing,
        sharedEpicBranch,
        normalizedSharedEpicBranch,
        branchAdvancedPastCandidate:
          remoteHead.headSha !== expectedHeadSha &&
          canUseCandidatePinnedSharedBranch,
      },
    });
    return {
      branchName,
      baseCommitSha,
      expectedHeadSha,
      workspaceBaseSha,
      currentCandidateSha: currentCandidate?.candidateCommitSha ?? null,
      remoteHeadSha: remoteHead.headSha,
      repairedMetadata: metadataMissing,
      createdRemoteBranch: false,
      sharedEpicBranch,
    };
  }

  const workspace = await input.workspaceManager.prepareImplementerWorkspace(
    input.run.id,
    input.repo,
    expectedHeadSha,
    branchName,
  );
  try {
    const branch = await createRemoteBranchIfMissing(
      workspace.workspacePath,
      input.repo,
      branchName,
      expectedHeadSha,
    );
    await input.oneShotDb.events.createEvent({
      oneshot_run_id: input.run.id,
      event_type: metadataMissing ? "run_branch_repaired" : "run_branch_created",
      from_state: input.run.state,
      to_state: input.run.state,
      stage: input.stage,
      metadata_json: {
        repoId: input.repo.id,
        repoName: input.repo.repo_name,
        targetBranchName: input.run.branch_name,
        runBranchName: branchName,
        runBranchBaseSha: baseCommitSha,
        expectedHeadSha,
        workspaceBaseSha: branch.headSha,
        currentCandidateSha: currentCandidate?.candidateCommitSha ?? null,
        remoteHeadSha: branch.headSha,
        repairedMetadata: metadataMissing,
        createdRemoteBranch: branch.created,
        sharedEpicBranch,
        normalizedSharedEpicBranch,
        workspacePath: workspace.workspacePath,
      },
    });
    input.logger.info(
      {
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        repoName: input.repo.repo_name,
        runBranchName: branchName,
        expectedHeadSha,
        workspaceBaseSha: branch.headSha,
        currentCandidateSha: currentCandidate?.candidateCommitSha ?? null,
        branchCreated: branch.created,
        sharedEpicBranch,
        repairedMetadata: metadataMissing,
      },
      "Ensured OneShot run branch contract",
    );
    return {
      branchName,
      baseCommitSha,
      expectedHeadSha,
      workspaceBaseSha: branch.headSha,
      currentCandidateSha: currentCandidate?.candidateCommitSha ?? null,
      remoteHeadSha: branch.headSha,
      repairedMetadata: metadataMissing,
      createdRemoteBranch: branch.created,
      sharedEpicBranch,
    };
  } finally {
    await workspace.cleanup().catch((error: unknown) => {
      input.logger.warn(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          repoName: input.repo.repo_name,
          workspacePath: workspace.workspacePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Run branch contract workspace cleanup failed",
      );
      return undefined;
    });
  }
}
