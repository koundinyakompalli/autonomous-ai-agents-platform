import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OneShotRun } from "./types.js";

const {
  createRemoteBranchIfMissingMock,
  getRemoteBranchHeadMock,
  isAncestorMock,
} = vi.hoisted(() => ({
  createRemoteBranchIfMissingMock: vi.fn(),
  getRemoteBranchHeadMock: vi.fn(),
  isAncestorMock: vi.fn(),
}));

vi.mock("./git.js", () => ({
  createRemoteBranchIfMissing: createRemoteBranchIfMissingMock,
  getRemoteBranchHead: getRemoteBranchHeadMock,
  isAncestor: isAncestorMock,
}));

import { ensureRunBranchContract } from "./run-branch-contract.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const CANDIDATE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const RUN_BRANCH = "oneshot/cpdev-20686-run-84";
const EPIC_BRANCH = "oneshot/epic/cpdev-20000/master";

function buildRun(overrides: Partial<OneShotRun> = {}): OneShotRun {
  const now = new Date("2026-05-05T12:00:00.000Z");
  return {
    id: 84,
    run_group_id: null,
    workspace_mode: "v2",
    jira_key: "CPDEV-20686",
    source_task_management_id: 7,
    customer_id: 1,
    repo_id: 11,
    branch_name: "master",
    base_commit_sha: BASE_SHA,
    run_branch_name: RUN_BRANCH,
    run_branch_base_sha: BASE_SHA,
    run_branch_created_at: now,
    state: "queued_for_planning",
    max_review_loops: 3,
    review_loop_count: 0,
    current_plan_version: null,
    current_review_version: null,
    current_implementation_version: null,
    current_implementation_branch: RUN_BRANCH,
    current_implementation_commit_sha: null,
    current_code_review_version: null,
    current_test_version: null,
    current_pr_url: null,
    final_disposition: null,
    last_error: null,
    max_total_tokens: 2_000_000,
    total_tokens_used: 0,
    verification_loop_count: 0,
    max_verification_loops: 3,
    planning_attempt_count: 0,
    implementation_attempt_count: 0,
    code_review_attempt_count: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function buildDeps() {
  const cleanup = vi.fn().mockResolvedValue(undefined);
  return {
    repo: {
      id: 11,
      repo_name: "core-app",
      repo_url: "https://github.com/org/core-app.git",
    },
    oneShotDb: {
      runs: {
        ensureRunBranchContract: vi.fn().mockResolvedValue(undefined),
      },
      candidateVersions: {
        getCurrentCandidate: vi.fn().mockResolvedValue(null),
      },
      events: {
        createEvent: vi.fn().mockResolvedValue(undefined),
      },
    },
    workspaceManager: {
      prepareImplementerWorkspace: vi.fn().mockResolvedValue({
        workspacePath: "/tmp/worktree",
        statePath: "/tmp/state",
        cleanup,
      }),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    cleanup,
  };
}

describe("ensureRunBranchContract", () => {
  beforeEach(() => {
    createRemoteBranchIfMissingMock.mockReset();
    getRemoteBranchHeadMock.mockReset();
    isAncestorMock.mockReset();
    createRemoteBranchIfMissingMock.mockResolvedValue({
      created: true,
      headSha: BASE_SHA,
    });
    isAncestorMock.mockResolvedValue(true);
  });

  it("reuses an existing run branch at the expected base SHA", async () => {
    getRemoteBranchHeadMock.mockResolvedValue({
      branchName: RUN_BRANCH,
      headSha: BASE_SHA,
    });
    const deps = buildDeps();

    await expect(
      ensureRunBranchContract({
        run: buildRun(),
        repo: deps.repo as never,
        oneShotDb: deps.oneShotDb as never,
        workspaceManager: deps.workspaceManager as never,
        stage: "planner",
        logger: deps.logger as never,
      }),
    ).resolves.toMatchObject({
      branchName: RUN_BRANCH,
      baseCommitSha: BASE_SHA,
      expectedHeadSha: BASE_SHA,
      remoteHeadSha: BASE_SHA,
      repairedMetadata: false,
      createdRemoteBranch: false,
    });

    expect(deps.oneShotDb.runs.ensureRunBranchContract).not.toHaveBeenCalled();
    expect(deps.workspaceManager.prepareImplementerWorkspace).not.toHaveBeenCalled();
    expect(isAncestorMock).not.toHaveBeenCalled();
    expect(deps.oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "run_branch_reused",
        metadata_json: expect.objectContaining({
          targetBranchName: "master",
          runBranchName: RUN_BRANCH,
          expectedHeadSha: BASE_SHA,
        }),
      }),
    );
  });

  it("does not mark per-run branches as shared just because an Epic key is present", async () => {
    getRemoteBranchHeadMock.mockResolvedValue({
      branchName: RUN_BRANCH,
      headSha: BASE_SHA,
    });
    const deps = buildDeps();

    await expect(
      ensureRunBranchContract({
        run: buildRun({ epic_key: "CPDEV-20000" }),
        repo: deps.repo as never,
        oneShotDb: deps.oneShotDb as never,
        workspaceManager: deps.workspaceManager as never,
        stage: "planner",
        logger: deps.logger as never,
      }),
    ).resolves.toMatchObject({
      branchName: RUN_BRANCH,
      sharedEpicBranch: false,
    });

    expect(deps.oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          sharedEpicBranch: false,
        }),
      }),
    );
  });

  it("repairs missing run branch metadata when the remote branch already exists", async () => {
    getRemoteBranchHeadMock.mockResolvedValue({
      branchName: RUN_BRANCH,
      headSha: BASE_SHA,
    });
    const deps = buildDeps();

    await ensureRunBranchContract({
      run: buildRun({
        run_branch_name: null,
        run_branch_base_sha: null,
        run_branch_created_at: null,
        current_implementation_branch: null,
      }),
      repo: deps.repo as never,
      oneShotDb: deps.oneShotDb as never,
      workspaceManager: deps.workspaceManager as never,
      stage: "reviewer",
      logger: deps.logger as never,
    });

    expect(deps.oneShotDb.runs.ensureRunBranchContract).toHaveBeenCalledWith({
      runId: 84,
      branchName: RUN_BRANCH,
      baseCommitSha: BASE_SHA,
    });
    expect(deps.oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "run_branch_repaired",
      }),
    );
  });

  it("creates the remote run branch from the current candidate SHA when missing", async () => {
    getRemoteBranchHeadMock.mockResolvedValue(null);
    createRemoteBranchIfMissingMock.mockResolvedValue({
      created: true,
      headSha: CANDIDATE_SHA,
    });
    const deps = buildDeps();

    await ensureRunBranchContract({
      run: buildRun({
        current_implementation_version: 2,
        current_implementation_commit_sha: CANDIDATE_SHA,
      }),
      repo: deps.repo as never,
      oneShotDb: deps.oneShotDb as never,
      workspaceManager: deps.workspaceManager as never,
      stage: "tester",
      logger: deps.logger as never,
    });

    expect(deps.workspaceManager.prepareImplementerWorkspace).toHaveBeenCalledWith(
      84,
      deps.repo,
      CANDIDATE_SHA,
      RUN_BRANCH,
    );
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledWith(
      "/tmp/worktree",
      deps.repo,
      RUN_BRANCH,
      CANDIDATE_SHA,
    );
    expect(deps.cleanup).toHaveBeenCalledOnce();
    expect(deps.oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "run_branch_created",
        metadata_json: expect.objectContaining({
          expectedHeadSha: CANDIDATE_SHA,
          createdRemoteBranch: true,
        }),
      }),
    );
  });

  it("uses the candidate table when the run implementation SHA was cleared", async () => {
    getRemoteBranchHeadMock.mockResolvedValue({
      branchName: RUN_BRANCH,
      headSha: CANDIDATE_SHA,
    });
    const deps = buildDeps();
    deps.oneShotDb.candidateVersions.getCurrentCandidate.mockResolvedValue({
      candidateCommitSha: CANDIDATE_SHA,
    });

    await expect(
      ensureRunBranchContract({
        run: buildRun({
          current_implementation_version: 3,
          current_implementation_commit_sha: null,
        }),
        repo: deps.repo as never,
        oneShotDb: deps.oneShotDb as never,
        workspaceManager: deps.workspaceManager as never,
        stage: "implementer",
        logger: deps.logger as never,
      }),
    ).resolves.toMatchObject({
      expectedHeadSha: CANDIDATE_SHA,
      currentCandidateSha: CANDIDATE_SHA,
      remoteHeadSha: CANDIDATE_SHA,
    });

    expect(deps.workspaceManager.prepareImplementerWorkspace).not.toHaveBeenCalled();
    expect(deps.oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          currentCandidateSha: CANDIDATE_SHA,
          expectedHeadSha: CANDIDATE_SHA,
        }),
      }),
    );
  });

  it("normalizes pre-planning legacy shared Epic branches to per-run branches", async () => {
    getRemoteBranchHeadMock.mockImplementation(
      async (_repo: unknown, branchName: string) =>
        branchName === RUN_BRANCH
          ? null
          : { branchName: EPIC_BRANCH, headSha: CANDIDATE_SHA },
    );
    const deps = buildDeps();

    await expect(
      ensureRunBranchContract({
        run: buildRun({
          epic_key: "CPDEV-20000",
          run_branch_name: EPIC_BRANCH,
          current_implementation_branch: EPIC_BRANCH,
        }),
        repo: deps.repo as never,
        oneShotDb: deps.oneShotDb as never,
        workspaceManager: deps.workspaceManager as never,
        stage: "planner",
        logger: deps.logger as never,
      }),
    ).resolves.toMatchObject({
      branchName: RUN_BRANCH,
      baseCommitSha: BASE_SHA,
      expectedHeadSha: BASE_SHA,
      workspaceBaseSha: BASE_SHA,
      remoteHeadSha: BASE_SHA,
      createdRemoteBranch: true,
      sharedEpicBranch: false,
    });

    expect(getRemoteBranchHeadMock).toHaveBeenCalledWith(deps.repo, RUN_BRANCH);
    expect(deps.workspaceManager.prepareImplementerWorkspace).toHaveBeenCalledWith(
      84,
      deps.repo,
      BASE_SHA,
      RUN_BRANCH,
    );
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledWith(
      "/tmp/worktree",
      deps.repo,
      RUN_BRANCH,
      BASE_SHA,
    );
    expect(deps.cleanup).toHaveBeenCalledOnce();
    expect(deps.oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "run_branch_repaired",
        metadata_json: expect.objectContaining({
          runBranchName: RUN_BRANCH,
          expectedHeadSha: BASE_SHA,
          workspaceBaseSha: BASE_SHA,
          remoteHeadSha: BASE_SHA,
          sharedEpicBranch: false,
          normalizedSharedEpicBranch: true,
        }),
      }),
    );
  });

  it("does not inspect advanced shared Epic ancestry when normalizing pre-planning rows", async () => {
    getRemoteBranchHeadMock.mockImplementation(
      async (_repo: unknown, branchName: string) =>
        branchName === RUN_BRANCH
          ? null
          : { branchName: EPIC_BRANCH, headSha: CANDIDATE_SHA },
    );
    isAncestorMock.mockResolvedValue(false);
    const deps = buildDeps();

    await expect(
      ensureRunBranchContract({
        run: buildRun({
          epic_key: "CPDEV-20000",
          run_branch_name: EPIC_BRANCH,
          current_implementation_branch: EPIC_BRANCH,
        }),
        repo: deps.repo as never,
        oneShotDb: deps.oneShotDb as never,
        workspaceManager: deps.workspaceManager as never,
        stage: "planner",
        logger: deps.logger as never,
      }),
    ).resolves.toMatchObject({
      branchName: RUN_BRANCH,
      sharedEpicBranch: false,
      createdRemoteBranch: true,
    });

    expect(getRemoteBranchHeadMock).toHaveBeenCalledWith(deps.repo, RUN_BRANCH);
    expect(isAncestorMock).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalledOnce();
  });

  it("allows candidate-pinned Epic code review when the shared branch advanced", async () => {
    const advancedHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    getRemoteBranchHeadMock.mockResolvedValue({
      branchName: EPIC_BRANCH,
      headSha: advancedHeadSha,
    });
    const deps = buildDeps();

    await expect(
      ensureRunBranchContract({
        run: buildRun({
          epic_key: "CPDEV-20000",
          run_branch_name: EPIC_BRANCH,
          current_implementation_branch: EPIC_BRANCH,
          current_implementation_version: 1,
          current_implementation_commit_sha: CANDIDATE_SHA,
        }),
        repo: deps.repo as never,
        oneShotDb: deps.oneShotDb as never,
        workspaceManager: deps.workspaceManager as never,
        stage: "code-reviewer",
        logger: deps.logger as never,
      }),
    ).resolves.toMatchObject({
      branchName: EPIC_BRANCH,
      expectedHeadSha: CANDIDATE_SHA,
      workspaceBaseSha: CANDIDATE_SHA,
      remoteHeadSha: advancedHeadSha,
      sharedEpicBranch: true,
    });

    expect(deps.workspaceManager.prepareImplementerWorkspace).not.toHaveBeenCalled();
    expect(deps.oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "run_branch_reused",
        metadata_json: expect.objectContaining({
          expectedHeadSha: CANDIDATE_SHA,
          workspaceBaseSha: CANDIDATE_SHA,
          remoteHeadSha: advancedHeadSha,
          sharedEpicBranch: true,
          branchAdvancedPastCandidate: true,
        }),
      }),
    );
  });

  it("rejects a remote run branch at an unexpected SHA", async () => {
    getRemoteBranchHeadMock.mockResolvedValue({
      branchName: RUN_BRANCH,
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const deps = buildDeps();

    await expect(
      ensureRunBranchContract({
        run: buildRun(),
        repo: deps.repo as never,
        oneShotDb: deps.oneShotDb as never,
        workspaceManager: deps.workspaceManager as never,
        stage: "implementer",
        logger: deps.logger as never,
      }),
    ).rejects.toThrow(
      `Remote run branch ${RUN_BRANCH} exists at aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; expected ${BASE_SHA}`,
    );
  });
});
