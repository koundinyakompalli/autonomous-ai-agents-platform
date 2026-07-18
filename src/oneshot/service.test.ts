import { afterEach, describe, expect, it, vi } from "vitest";

const {
  cleanupRunWorkspaceMock,
  prepareImplementerWorkspaceMock,
  createRemoteBranchIfMissingMock,
  getRemoteBranchHeadMock,
  isAncestorMock,
  pushBranchMock,
  workspaceManagerConfigMock,
  generatePostmortemArtifactMock,
  fetchCommitStatusSummaryMock,
  findOpenPullRequestMock,
  loggerMock,
} = vi.hoisted(() => ({
  cleanupRunWorkspaceMock: vi.fn(),
  prepareImplementerWorkspaceMock: vi.fn().mockResolvedValue({
    workspacePath: "/tmp/oneshot-workspace",
    statePath: "/tmp/oneshot-state",
    cleanup: vi.fn().mockResolvedValue(undefined),
  }),
  createRemoteBranchIfMissingMock: vi.fn().mockResolvedValue({
    created: true,
    headSha: "abc123",
  }),
  getRemoteBranchHeadMock: vi.fn().mockResolvedValue(null),
  isAncestorMock: vi.fn().mockResolvedValue(true),
  pushBranchMock: vi.fn().mockResolvedValue(undefined),
  workspaceManagerConfigMock: vi.fn(),
  generatePostmortemArtifactMock: vi.fn().mockResolvedValue(undefined),
  fetchCommitStatusSummaryMock: vi.fn(),
  findOpenPullRequestMock: vi.fn(),
  loggerMock: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("./workspaces.js", () => ({
  OneShotWorkspaceManager: class {
    constructor(config: unknown) {
      workspaceManagerConfigMock(config);
    }

    cleanupRunWorkspace = cleanupRunWorkspaceMock;
    prepareImplementerWorkspace = prepareImplementerWorkspaceMock;
  },
  createLeasedOneShotWorkspaceManager: (
    _oneShotDb: unknown,
    config: unknown,
  ) => {
    workspaceManagerConfigMock(config);
    return {
      cleanupRunWorkspace: cleanupRunWorkspaceMock,
      prepareImplementerWorkspace: prepareImplementerWorkspaceMock,
    };
  },
}));

vi.mock("./git.js", () => ({
  createRemoteBranchIfMissing: createRemoteBranchIfMissingMock,
  getRemoteBranchHead: getRemoteBranchHeadMock,
  isAncestor: isAncestorMock,
  pushBranch: pushBranchMock,
}));

vi.mock("./state-transitions.js", () => ({
  buildPostmortemContext: <T>(input: T) => input,
  generatePostmortemArtifact: generatePostmortemArtifactMock,
}));

vi.mock("./github.js", () => ({
  fetchCommitStatusSummary: fetchCommitStatusSummaryMock,
  findOpenPullRequest: findOpenPullRequestMock,
  parseGitHubRepoUrl: (url: string) => {
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/);
    return {
      owner: match?.[1] ?? "acme",
      repo: match?.[2] ?? "project",
    };
  },
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => loggerMock,
}));

import { OneShotService } from "./service.js";

const ORIGINAL_REPOSITORY_PATH = process.env.REPOSITORY_PATH;
const ORIGINAL_ONESHOT_REPO_ADMIN_BASE = process.env.ONESHOT_REPO_ADMIN_BASE;
const ORIGINAL_ONESHOT_ARTIFACT_BUCKET = process.env.ONESHOT_ARTIFACT_BUCKET;
const ORIGINAL_ONESHOT_HANDOFF_RETRY_DELAYS_MS =
  process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS;
const RUN_380_WORKFLOW_TIMEOUT =
  "Command failed: git push --force-with-lease=\"refs/heads/oneshot/cpdev-23753-run-380:\" \"https://x-access-token:secret@github.com/mhk-repos/cp-medhok-monorepo.git\" \"46e7d6f3015719fe1254c0ca8626d0c154ec9fd0:refs/heads/oneshot/cpdev-23753-run-380\"\n" +
  "To https://github.com/mhk-repos/cp-medhok-monorepo.git\n" +
  " ! [remote rejected]         46e7d6f3015719fe1254c0ca8626d0c154ec9fd0 -> oneshot/cpdev-23753-run-380 (Unable to determine if workflow can be created or updated due to timeout; `workflows` scope may be required.)\n" +
  "error: failed to push some refs to 'https://github.com/mhk-repos/cp-medhok-monorepo.git'";

function createConnection(
  queryImpl: (sql: string, params?: unknown[]) => Promise<unknown>,
) {
  return {
    query: vi.fn(queryImpl),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
}

function buildRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    run_group_id: null,
    workspace_mode: "v2",
    jira_key: "CPDEV-101",
    source_task_management_id: 201,
    customer_id: 301,
    repo_id: 401,
    branch_name: "main",
    base_commit_sha: "old-base-sha",
    run_branch_name: "oneshot/cpdev-101-run-101",
    run_branch_base_sha: "old-base-sha",
    run_branch_created_at: new Date("2026-04-17T00:00:00.000Z"),
    state: "escalated",
    max_review_loops: 3,
    review_loop_count: 0,
    current_plan_version: 1,
    current_review_version: 1,
    current_implementation_version: 1,
    current_implementation_branch: "oneshot/cpdev-101-run-101",
    current_implementation_commit_sha: "impl-sha",
    current_code_review_version: 1,
    current_test_version: null,
    current_pr_url: null,
    final_disposition: "code_review_escalated",
    last_error: "Needs review",
    max_total_tokens: 2000000,
    total_tokens_used: 0,
    verification_loop_count: 0,
    max_verification_loops: 3,
    planning_attempt_count: 0,
    implementation_attempt_count: 0,
    code_review_attempt_count: 0,
    created_at: new Date("2026-04-17T00:00:00.000Z"),
    updated_at: new Date("2026-04-17T00:00:00.000Z"),
    ...overrides,
  };
}

function buildPrOpenRunRow(overrides: Record<string, unknown> = {}) {
  return buildRunRow({
    state: "pr_open",
    current_pr_url: "https://github.com/acme/project/pull/12",
    current_implementation_branch: "oneshot/cpdev-101-run-101",
    current_implementation_commit_sha: "candidate-sha",
    current_test_version: 1,
    final_disposition: "completed_ready",
    last_error: null,
    ...overrides,
  });
}

function buildTestResult(overrides: Record<string, unknown> = {}) {
  return {
    resolvedCommand: "npm test",
    commandSource: "implementation",
    executionKind: "automated_tests",
    executedCommands: ["npm test"],
    executedValidationChecks: [],
    skippedTestCommands: [],
    unverified: false,
    exitCode: 0,
    passed: true,
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    failedTests: [],
    truncatedOutput: "",
    parserNotes: [],
    implementationVersion: 1,
    codeReviewVersion: 1,
    durationMs: 1000,
    ...overrides,
  };
}

function buildCreateQualifiedRunInput(overrides: Record<string, unknown> = {}) {
  return {
    jiraKey: "CPDEV-302",
    ticketSummary: "Qualify with workspace v2",
    sourceTaskManagementId: 78,
    customerId: 25,
    repo: {
      id: 1,
      repo_name: "core-app",
      repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      default_branch: "master",
    } as any,
    branchName: "master",
    baseCommitSha: "abc123",
    qualification: {
      qualified: true,
      repoId: 1,
      branchName: "master",
      baseCommitSha: "abc123",
      requirementsSummary: ["Implement OCR status propagation"],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      repoInspectionPerformed: true,
      inspectedFiles: ["src/example.ts"],
      inspectionSummary: "Qualified after inspection.",
    },
    ...overrides,
  };
}

function buildArtifact(
  stage: string,
  version: number,
  metadata_json: Record<string, unknown> = {},
) {
  return {
    id: version,
    oneshot_run_id: 101,
    stage,
    version,
    status: "completed",
    s3_bucket: "specter-test-results",
    s3_key: `oneshot/CPDEV-101/run-101/${stage}/v${version}.json`,
    provider: null,
    model: null,
    metadata_json,
    started_at: null,
    completed_at: null,
    created_at: new Date("2026-05-05T00:00:00.000Z"),
  };
}

function buildCiReconcileService(input: {
  run?: Record<string, unknown>;
  artifacts?: Partial<Record<string, unknown | null>>;
  testResult?: Record<string, unknown>;
  s3Error?: Error;
}) {
  const run = buildPrOpenRunRow(input.run);
  const artifacts = {
    plan: buildArtifact("plan", 1),
    code_review: buildArtifact("code_review", 1),
    implementation: buildArtifact("implementation", 1, {
      implementationCommitSha: run.current_implementation_commit_sha,
    }),
    test_result: buildArtifact("test_result", 1),
    ...input.artifacts,
  };
  const runsDb = {
    getPrOpenRunsForCiReconciliation: vi.fn().mockResolvedValue([run]),
    updateRunState: vi.fn().mockResolvedValue(undefined),
  };
  const artifactsDb = {
    getArtifact: vi
      .fn()
      .mockImplementation(
        async (_runId: number, stage: string) =>
          artifacts[stage as keyof typeof artifacts] ?? null,
      ),
  };
  const eventsDb = {
    createEvent: vi.fn().mockResolvedValue(undefined),
  };
  const oneShotDatabase = {
    runs: runsDb,
    artifacts: artifactsDb,
    events: eventsDb,
  };
  const db = {
    getRepositoryById: vi.fn().mockResolvedValue({
      repo_url: "https://github.com/acme/project.git",
    }),
    getPool: vi.fn(),
  };
  const s3Send = vi.fn().mockImplementation(async () => {
    if (input.s3Error) {
      throw input.s3Error;
    }
    return {
      Body: {
        transformToString: vi
          .fn()
          .mockResolvedValue(JSON.stringify(buildTestResult(input.testResult))),
      },
    };
  });
  const service = new OneShotService(
    db as any,
    { publishStageMessage: vi.fn() } as any,
    { send: s3Send } as any,
  );
  vi.spyOn(service, "database", "get").mockReturnValue(oneShotDatabase as any);

  return {
    artifactsDb,
    db,
    eventsDb,
    run,
    runsDb,
    s3Send,
    service,
  };
}

describe("OneShotService cleanupTerminalWorkspaces", () => {
  afterEach(() => {
    cleanupRunWorkspaceMock.mockReset();
    workspaceManagerConfigMock.mockReset();
    generatePostmortemArtifactMock.mockReset();
    generatePostmortemArtifactMock.mockResolvedValue(undefined);
    vi.restoreAllMocks();
    process.env.REPOSITORY_PATH = ORIGINAL_REPOSITORY_PATH;
    process.env.ONESHOT_REPO_ADMIN_BASE = ORIGINAL_ONESHOT_REPO_ADMIN_BASE;
    process.env.ONESHOT_ARTIFACT_BUCKET = ORIGINAL_ONESHOT_ARTIFACT_BUCKET;
  });

  it("includes pr_open runs in terminal workspace cleanup and uses the repo-admin root for cleanup discovery", async () => {
    process.env.REPOSITORY_PATH = "/tmp/repositories";
    process.env.ONESHOT_REPO_ADMIN_BASE = "/tmp/repo-admin";
    cleanupRunWorkspaceMock.mockResolvedValue("cleaned");

    const queryMock = vi
      .fn()
      .mockResolvedValue([[{ id: 101, jira_key: "CPDEV-101" }], undefined]);

    const service = new OneShotService({
      getPool: () => ({
        query: queryMock,
      }),
    } as any);

    const result = await service.cleanupTerminalWorkspaces(24, 10);

    expect(result).toEqual({ cleaned: 1, failed: 0 });
    expect(cleanupRunWorkspaceMock).toHaveBeenCalledWith(101);
    expect(workspaceManagerConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoBasePath: "/tmp/repo-admin",
      }),
    );
    expect(String(queryMock.mock.calls[0]?.[0])).toContain("'pr_open'");
  });

  it("picks requested cleanup immediately and records retryable skipped status", async () => {
    cleanupRunWorkspaceMock.mockResolvedValue("skipped_lease_held");
    const completedEvents: Array<Record<string, unknown>> = [];
    const queryMock = vi
      .fn()
      .mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT r.id, r.jira_key")) {
          expect(String(sql)).toContain("workspace_cleanup_requested");
          expect(String(sql)).toContain("workspace_cleanup_completed");
          expect(String(sql)).toContain("IN ('cleaned', 'not_found')");
          expect(params).toEqual([24, 10]);
          return [[{ id: 102, jira_key: "CPDEV-102" }], undefined];
        }

        if (sql.includes("INSERT INTO oneshot_run_events")) {
          expect(params?.[1]).toBe("workspace_cleanup_completed");
          completedEvents.push(JSON.parse(String(params?.[5])));
          return [{ affectedRows: 1 }];
        }

        throw new Error(`Unexpected query: ${sql}`);
      });

    const service = new OneShotService({
      getPool: () => ({
        query: queryMock,
      }),
    } as any);

    const result = await service.cleanupTerminalWorkspaces(24, 10);

    expect(result).toEqual({ cleaned: 0, failed: 0 });
    expect(cleanupRunWorkspaceMock).toHaveBeenCalledWith(102);
    expect(completedEvents).toEqual([
      expect.objectContaining({
        status: "skipped_lease_held",
        trigger: "terminal_cleanup",
        olderThanHours: 24,
      }),
    ]);
  });

  it("cleans stale active workspaces before republishing the run", async () => {
    cleanupRunWorkspaceMock.mockResolvedValue("cleaned");
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const poolQueryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs")) {
        return [
          [
            buildRunRow({
              state: "planning",
              current_plan_version: null,
              final_disposition: null,
            }),
          ],
        ];
      }

      return [{ affectedRows: 1 }];
    });
    const connection = createConnection(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
          expect(params).toEqual([101]);
          return [
            [
              buildRunRow({
                state: "planning",
                current_plan_version: null,
                final_disposition: null,
              }),
            ],
          ];
        }

        if (sql.includes("UPDATE oneshot_runs")) {
          expect(params?.slice(0, 4)).toEqual([
            "failed",
            "run_failed",
            "OneShot run auto-terminated after exceeding the 45 minute stale timeout while in planning.",
            101,
          ]);
          return [{ affectedRows: 1 }];
        }

        if (sql.includes("INSERT INTO oneshot_run_events")) {
          expect(params?.slice(0, 5)).toEqual([
            101,
            "state_transition",
            "planning",
            "failed",
            "planning",
          ]);
          expect(String(params?.[5])).toContain('"reason":"stale_timeout"');
          expect(String(params?.[5])).toContain('"staleTimeoutMinutes":45');
          return [{ affectedRows: 1 }];
        }

        if (sql.includes("INSERT INTO oneshot_notifications")) {
          expect(params?.slice(0, 3)).toEqual([101, "CPDEV-101", "run_failed"]);
          expect(String(params?.[3])).toContain(
            "OneShot Run Failed for CPDEV-101",
          );
          expect(String(params?.[3])).toContain("auto-terminated");
          return [{ insertId: 1 }];
        }

        throw new Error(`Unexpected connection query: ${sql}`);
      },
    );

    const service = new OneShotService(
      {
        getPool: () => ({
          query: poolQueryMock,
          getConnection: vi.fn().mockResolvedValue(connection),
        }),
      } as any,
      { publishStageMessage } as any,
      {} as any,
    );

    const result = await service.reconcileStuckRuns(10);

    expect(result).toEqual({ republished: 0, terminated: 1, failed: 0 });
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual([10, 20]);
    expect(cleanupRunWorkspaceMock).toHaveBeenCalledWith(101);
    expect(generatePostmortemArtifactMock).toHaveBeenCalledWith(
      expect.anything(),
      101,
      expect.objectContaining({
        jiraKey: "CPDEV-101",
        failedStage: "planning",
      }),
    );
    expect(publishStageMessage).not.toHaveBeenCalled();
  });

  it("fetches active runs at the 20 minute floor but skips planning until its 45 minute threshold", async () => {
    cleanupRunWorkspaceMock.mockResolvedValue("cleaned");
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const poolQueryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs")) {
        return [
          [
            buildRunRow({
              state: "planning",
              current_plan_version: null,
              final_disposition: null,
              updated_at: new Date(Date.now() - 30 * 60_000),
            }),
          ],
        ];
      }

      return [{ affectedRows: 1 }];
    });

    const service = new OneShotService(
      {
        getPool: () => ({
          query: poolQueryMock,
          getConnection: vi.fn(),
        }),
      } as any,
      { publishStageMessage } as any,
      {} as any,
    );

    const result = await service.reconcileStuckRuns(10);

    expect(result).toEqual({ republished: 0, terminated: 0, failed: 0 });
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual([10, 20]);
    expect(cleanupRunWorkspaceMock).not.toHaveBeenCalled();
    expect(publishStageMessage).not.toHaveBeenCalled();
  });

  it("keeps queued stale runs on the republish path", async () => {
    cleanupRunWorkspaceMock.mockResolvedValue("cleaned");
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const poolQueryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs")) {
        return [
          [
            buildRunRow({
              state: "queued_for_planning",
              current_plan_version: null,
              final_disposition: null,
            }),
          ],
        ];
      }

      return [{ affectedRows: 1 }];
    });

    const service = new OneShotService(
      {
        getPool: () => ({
          query: poolQueryMock,
          getConnection: vi.fn(),
        }),
      } as any,
      { publishStageMessage } as any,
      {} as any,
    );

    const result = await service.reconcileStuckRuns(10);

    expect(result).toEqual({ republished: 1, terminated: 0, failed: 0 });
    expect(cleanupRunWorkspaceMock).not.toHaveBeenCalled();
    expect(publishStageMessage).toHaveBeenCalledWith(
      101,
      "planning",
      1,
      "queued_for_planning",
      false,
      undefined,
    );
  });

  it("republishes a first manual Build retry as base when no implementation output exists", async () => {
    cleanupRunWorkspaceMock.mockResolvedValue("cleaned");
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const poolQueryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs")) {
        return [
          [
            buildRunRow({
              state: "queued_for_implementation",
              current_implementation_version: 2,
              current_implementation_branch: null,
              current_implementation_commit_sha: null,
              final_disposition: null,
            }),
          ],
        ];
      }

      return [{ affectedRows: 1 }];
    });

    const service = new OneShotService(
      {
        getPool: () => ({
          query: poolQueryMock,
          getConnection: vi.fn(),
        }),
      } as any,
      { publishStageMessage } as any,
      {} as any,
    );

    const result = await service.reconcileStuckRuns(10);

    expect(result).toEqual({ republished: 1, terminated: 0, failed: 0 });
    expect(cleanupRunWorkspaceMock).not.toHaveBeenCalled();
    expect(publishStageMessage).toHaveBeenCalledWith(
      101,
      "implementation",
      2,
      "queued_for_implementation",
      false,
      undefined,
    );
  });

  it("republishes a Build retry as revision only when prior implementation output exists", async () => {
    cleanupRunWorkspaceMock.mockResolvedValue("cleaned");
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const poolQueryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs")) {
        return [
          [
            buildRunRow({
              state: "queued_for_implementation",
              current_implementation_version: 2,
              current_implementation_branch: "oneshot/cpdev-101-run-101",
              current_implementation_commit_sha: "impl-sha",
              final_disposition: null,
            }),
          ],
        ];
      }

      return [{ affectedRows: 1 }];
    });

    const service = new OneShotService(
      {
        getPool: () => ({
          query: poolQueryMock,
          getConnection: vi.fn(),
        }),
      } as any,
      { publishStageMessage } as any,
      {} as any,
    );

    const result = await service.reconcileStuckRuns(10);

    expect(result).toEqual({ republished: 1, terminated: 0, failed: 0 });
    expect(publishStageMessage).toHaveBeenCalledWith(
      101,
      "implementation",
      2,
      "queued_for_implementation",
      true,
      undefined,
    );
  });

  it("leaves a stale active run terminal even when workspace cleanup fails", async () => {
    cleanupRunWorkspaceMock.mockRejectedValue(new Error("poisoned worktree"));
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const poolQueryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs")) {
        return [
          [
            buildRunRow({
              state: "planning",
              current_plan_version: null,
              final_disposition: null,
            }),
          ],
        ];
      }

      return [{ affectedRows: 1 }];
    });
    const connection = createConnection(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [
          [
            buildRunRow({
              state: "planning",
              current_plan_version: null,
              final_disposition: null,
            }),
          ],
        ];
      }

      if (sql.includes("UPDATE oneshot_runs")) {
        return [{ affectedRows: 1 }];
      }

      if (sql.includes("INSERT INTO oneshot_run_events")) {
        return [{ affectedRows: 1 }];
      }

      if (sql.includes("INSERT INTO oneshot_notifications")) {
        return [{ insertId: 1 }];
      }

      throw new Error(`Unexpected connection query: ${sql}`);
    });

    const service = new OneShotService(
      {
        getPool: () => ({
          query: poolQueryMock,
          getConnection: vi.fn().mockResolvedValue(connection),
        }),
      } as any,
      { publishStageMessage } as any,
      {} as any,
    );

    const result = await service.reconcileStuckRuns(10);

    expect(result).toEqual({ republished: 0, terminated: 1, failed: 0 });
    expect(cleanupRunWorkspaceMock).toHaveBeenCalledWith(101);
    expect(generatePostmortemArtifactMock).toHaveBeenCalledWith(
      expect.anything(),
      101,
      expect.objectContaining({
        jiraKey: "CPDEV-101",
        failedStage: "planning",
      }),
    );
    expect(publishStageMessage).not.toHaveBeenCalled();
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
  });

  it("backfills operator-kill postmortems that were created outside the shared transition helper", async () => {
    const poolQueryMock = vi
      .fn()
      .mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT id, jira_key FROM oneshot_runs")) {
          expect(params).toEqual([24, 30]);
          return [[{ id: 101, jira_key: "CPDEV-101" }]];
        }

        if (sql.includes("ORDER BY occurred_at ASC, id ASC")) {
          expect(params).toEqual([101]);
          return [[{ id: 5001 }]];
        }

        if (sql.includes("WHERE id IN (?)")) {
          expect(params).toEqual([[5001]]);
          return [
            [
              {
                id: 5001,
                oneshot_run_id: 101,
                event_type: "state_transition",
                from_state: "reviewing",
                to_state: "failed",
                stage: "review",
                metadata_json: JSON.stringify({ reason: "operator_kill" }),
                occurred_at: "2026-04-20T00:05:00.000Z",
              },
            ],
          ];
        }

        throw new Error(`Unexpected pool query: ${sql}`);
      });

    const service = new OneShotService({
      getPool: () => ({
        query: poolQueryMock,
      }),
    } as any);

    const result = await service.backfillTerminationPostmortems(10);

    expect(result).toEqual({ generated: 1, failed: 0 });
    expect(generatePostmortemArtifactMock).toHaveBeenCalledWith(
      expect.anything(),
      101,
      expect.objectContaining({
        jiraKey: "CPDEV-101",
        failedStage: "review",
      }),
    );
  });
});

describe("OneShotService reconcilePrOpenCiReadiness", () => {
  afterEach(() => {
    fetchCommitStatusSummaryMock.mockReset();
    findOpenPullRequestMock.mockReset();
    loggerMock.debug.mockReset();
    loggerMock.error.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    vi.restoreAllMocks();
  });

  it("classifies a PR-open run as completed_ready when tests and CI are clean", async () => {
    findOpenPullRequestMock.mockResolvedValue({
      number: 12,
      headSha: "candidate-sha",
    });
    fetchCommitStatusSummaryMock.mockResolvedValue({
      state: "success",
      description: "All required checks passed.",
      statusCount: 1,
      checkRunCount: 2,
      requiredCheckState: "present",
    });
    const { eventsDb, runsDb, service } = buildCiReconcileService({});

    const result = await service.reconcilePrOpenCiReadiness(10);

    expect(result).toEqual({ checked: 1, refreshed: 1, blocked: 0, failed: 0 });
    expect(runsDb.updateRunState).toHaveBeenCalledWith(101, "pr_open", {
      last_error: null,
      final_disposition: "completed_ready",
    });
    expect(eventsDb.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "readiness_classified",
        metadata_json: expect.objectContaining({
          candidateSha: "candidate-sha",
          prNumber: 12,
          prHeadSha: "candidate-sha",
          readiness: expect.objectContaining({
            completionStatus: "completed_ready",
            readiness: "ready",
          }),
        }),
      }),
    );
  });

  it("blocks readiness when the open PR head drifts from the reviewed candidate SHA", async () => {
    findOpenPullRequestMock.mockResolvedValue({
      number: 12,
      headSha: "new-pr-head-sha",
    });
    const { eventsDb, runsDb, service } = buildCiReconcileService({});

    const result = await service.reconcilePrOpenCiReadiness(10);

    expect(result).toEqual({ checked: 1, refreshed: 1, blocked: 1, failed: 0 });
    expect(fetchCommitStatusSummaryMock).not.toHaveBeenCalled();
    expect(runsDb.updateRunState).toHaveBeenCalledWith(101, "pr_open", {
      last_error: expect.stringContaining("new-pr-head-sha"),
      final_disposition: "completed_needs_review",
    });
    expect(eventsDb.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "readiness_classified",
        metadata_json: expect.objectContaining({
          ciStatus: expect.objectContaining({
            state: "failure",
            details: ["pr_head_drift_detected"],
          }),
          readiness: expect.objectContaining({
            completionStatus: "completed_needs_review",
          }),
          prHeadSha: "new-pr-head-sha",
        }),
      }),
    );
  });

  it("continues without mutating readiness when the test artifact is missing", async () => {
    findOpenPullRequestMock.mockResolvedValue({
      number: 12,
      headSha: "candidate-sha",
    });
    fetchCommitStatusSummaryMock.mockResolvedValue({
      state: "success",
      description: "All required checks passed.",
      requiredCheckState: "present",
    });
    const { eventsDb, runsDb, service } = buildCiReconcileService({
      artifacts: {
        test_result: null,
      },
    });

    const result = await service.reconcilePrOpenCiReadiness(10);

    expect(result).toEqual({ checked: 1, refreshed: 0, blocked: 0, failed: 0 });
    expect(runsDb.updateRunState).not.toHaveBeenCalled();
    expect(eventsDb.createEvent).not.toHaveBeenCalled();
  });

  it("counts and logs per-run failures without stopping the reconciliation pass", async () => {
    findOpenPullRequestMock.mockResolvedValue({
      number: 12,
      headSha: "candidate-sha",
    });
    fetchCommitStatusSummaryMock.mockRejectedValue(
      new Error("GitHub unavailable"),
    );
    const { runsDb, service } = buildCiReconcileService({});

    const result = await service.reconcilePrOpenCiReadiness(10);

    expect(result).toEqual({ checked: 1, refreshed: 0, blocked: 0, failed: 1 });
    expect(runsDb.updateRunState).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 101,
        jiraKey: "CPDEV-101",
        error: "GitHub unavailable",
      }),
      "Failed to reconcile PR-open OneShot CI readiness",
    );
  });
});

describe("OneShotService createQualifiedRun", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    prepareImplementerWorkspaceMock.mockClear();
    prepareImplementerWorkspaceMock.mockResolvedValue({
      workspacePath: "/tmp/oneshot-workspace",
      statePath: "/tmp/oneshot-state",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    createRemoteBranchIfMissingMock.mockClear();
    createRemoteBranchIfMissingMock.mockResolvedValue({
      created: true,
      headSha: "abc123",
    });
    getRemoteBranchHeadMock.mockClear();
    getRemoteBranchHeadMock.mockResolvedValue(null);
    isAncestorMock.mockClear();
    isAncestorMock.mockResolvedValue(true);
    process.env.ONESHOT_ARTIFACT_BUCKET = ORIGINAL_ONESHOT_ARTIFACT_BUCKET;
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS =
      ORIGINAL_ONESHOT_HANDOFF_RETRY_DELAYS_MS;
  });

  it("persists qualification LLM metrics on the qualification artifact and run total", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [{ insertId: 101, affectedRows: 1 }]);
    const connection = {
      query: queryMock,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };

    const service = new OneShotService(
      {
        getPool: () => pool,
      } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    const result = await service.createQualifiedRun({
      jiraKey: "CPDEV-301",
      ticketSummary: "Qualify with metrics",
      jiraIssueType: "Story",
      jiraLabels: ["SONAR-AUTOFIX", "security"],
      sourceTaskManagementId: 77,
      customerId: 25,
      repo: {
        id: 1,
        repo_name: "core-app",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
        default_branch: "master",
      } as any,
      branchName: "master",
      baseCommitSha: "abc123",
      qualification: {
        qualified: true,
        repoId: 1,
        branchName: "master",
        baseCommitSha: "abc123",
        requirementsSummary: ["Implement OCR status propagation"],
        acceptanceCriteriaPresent: true,
        blockingReasons: [],
        nonBlockingWarnings: [],
        repoInspectionPerformed: true,
        inspectedFiles: ["src/example.ts"],
        inspectionSummary: "Qualified after inspection.",
      },
      qualificationMetrics: {
        durationMs: 1234,
        toolCalls: 2,
        tokensUsed: {
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 40,
        },
        costUsd: 0.05,
        modelUsed: "us.anthropic.claude-opus-4-6-v1",
      },
    });

    expect(result).toEqual({ runId: 101 });
    const artifactInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO oneshot_artifacts"),
    );
    expect(artifactInsert?.[1]?.[6]).toBe("anthropic");
    expect(artifactInsert?.[1]?.[7]).toBe("us.anthropic.claude-opus-4-6-v1");
    expect(JSON.parse(String(artifactInsert?.[1]?.[8]))).toMatchObject({
      qualified: true,
      processing_mode: "sonar_autofix",
      jira_issue_type: "Story",
      ticket_type: "sonar",
      ticket_type_source: "inferred_sonar",
      stage_tokens_used: 30,
      tokens_used: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
      },
      stage_cost_usd: 0.05,
      stage_duration_ms: 1234,
    });
    expect(
      JSON.parse(String(s3Send.mock.calls[0]?.[0].input.Body)),
    ).toMatchObject({
      jiraKey: "CPDEV-301",
      jiraIssueType: "Story",
      ticketType: "sonar",
      ticketTypeSource: "inferred_sonar",
      jiraLabels: ["SONAR-AUTOFIX", "security"],
      processingMode: "sonar_autofix",
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET total_tokens_used = total_tokens_used + ?"),
      [30, 101],
    );
    const runInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO oneshot_runs"),
    );
    expect(runInsert?.[1]?.slice(0, 9)).toEqual([
      "CPDEV-301",
      null,
      "Story",
      "sonar",
      "inferred_sonar",
      null,
      null,
      null,
      "v2",
    ]);
    expect(publishStageMessage).toHaveBeenCalledWith(
      101,
      "planning",
      1,
      "queued_for_planning",
      false,
    );
  });

  it("persists ticket evidence references and stats on qualification artifacts", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [{ insertId: 102, affectedRows: 1 }]);
    const connection = {
      query: queryMock,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };
    const service = new OneShotService(
      {
        getPool: () => pool,
      } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    await service.createQualifiedRun({
      jiraKey: "CPDEV-302",
      ticketSummary: "Qualify with evidence",
      taskDescription: "Generated task summary",
      sourceTaskManagementId: 78,
      customerId: 25,
      repo: {
        id: 1,
        repo_name: "core-app",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
        default_branch: "master",
      } as any,
      branchName: "master",
      baseCommitSha: "abc123",
      ticketEvidenceRef: {
        schemaVersion: "ticket-evidence.v1",
        bucket: "specter-tasks",
        key: "tasks/CPDEV-302/2026-06-17.ticket-evidence.v1.json",
        stats: {
          commentCount: 4,
          attachmentCount: 2,
          extractedAttachmentCount: 1,
          imageAttachmentCount: 1,
          warningCount: 1,
        },
      },
      qualification: {
        qualified: true,
        repoId: 1,
        branchName: "master",
        baseCommitSha: "abc123",
        requirementsSummary: ["Implement OCR status propagation"],
        acceptanceCriteriaPresent: true,
        blockingReasons: [],
        nonBlockingWarnings: [],
        repoInspectionPerformed: true,
        inspectedFiles: ["src/example.ts"],
        inspectionSummary: "Qualified after inspection.",
      },
    });

    const body = JSON.parse(String(s3Send.mock.calls[0]?.[0].input.Body));
    expect(body.ticketEvidenceRef).toEqual({
      schemaVersion: "ticket-evidence.v1",
      bucket: "specter-tasks",
      key: "tasks/CPDEV-302/2026-06-17.ticket-evidence.v1.json",
    });
    expect(body.ticketEvidenceStats).toEqual({
      commentCount: 4,
      attachmentCount: 2,
      extractedAttachmentCount: 1,
      imageAttachmentCount: 1,
      warningCount: 1,
    });
    expect(body.ticketEvidenceRef).not.toHaveProperty("stats");

    const artifactInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO oneshot_artifacts"),
    );
    expect(JSON.parse(String(artifactInsert?.[1]?.[8]))).toMatchObject({
      ticket_evidence: {
        present: true,
        comment_count: 4,
        attachment_count: 2,
        extracted_attachment_count: 1,
        image_attachment_count: 1,
        warning_count: 1,
      },
    });
  });

  it("freezes workspace v2 mode at run creation", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [{ insertId: 101, affectedRows: 1 }]);
    const connection = {
      query: queryMock,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };

    const service = new OneShotService(
      {
        getPool: () => pool,
      } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    await service.createQualifiedRun({
      jiraKey: "CPDEV-302",
      ticketSummary: "Qualify with workspace v2",
      sourceTaskManagementId: 78,
      customerId: 25,
      repo: {
        id: 1,
        repo_name: "core-app",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
        default_branch: "master",
      } as any,
      branchName: "master",
      baseCommitSha: "abc123",
      qualification: {
        qualified: true,
        repoId: 1,
        branchName: "master",
        baseCommitSha: "abc123",
        requirementsSummary: ["Implement OCR status propagation"],
        acceptanceCriteriaPresent: true,
        blockingReasons: [],
        nonBlockingWarnings: [],
        repoInspectionPerformed: true,
        inspectedFiles: ["src/example.ts"],
        inspectionSummary: "Qualified after inspection.",
      },
    });

    const runInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO oneshot_runs"),
    );
    expect(runInsert?.[1]?.[8]).toBe("v2");
    expect(prepareImplementerWorkspaceMock).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ repo_name: "core-app" }),
      "abc123",
      "oneshot/cpdev-302-run-101",
    );
    expect(getRemoteBranchHeadMock).not.toHaveBeenCalled();
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledWith(
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "core-app" }),
      "oneshot/cpdev-302-run-101",
      "abc123",
    );
    expect(publishStageMessage).toHaveBeenCalledWith(
      101,
      "planning",
      1,
      "queued_for_planning",
      false,
    );
  });

  it("stores Epic metadata but creates per-run implementation branches", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [{ insertId: 101, affectedRows: 1 }]);
    const connection = {
      query: queryMock,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };

    const service = new OneShotService(
      {
        getPool: () => pool,
      } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    await service.createQualifiedRun({
      jiraKey: "CPDEV-302",
      epicKey: "CPDEV-100",
      ticketSummary: "Qualify with Epic context",
      sourceTaskManagementId: 78,
      customerId: 25,
      repo: {
        id: 1,
        repo_name: "core-app",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
        default_branch: "master",
      } as any,
      branchName: "master",
      baseCommitSha: "abc123",
      qualification: {
        qualified: true,
        repoId: 1,
        branchName: "master",
        baseCommitSha: "abc123",
        requirementsSummary: ["Implement OCR status propagation"],
        acceptanceCriteriaPresent: true,
        blockingReasons: [],
        nonBlockingWarnings: [],
        repoInspectionPerformed: true,
        inspectedFiles: ["src/example.ts"],
        inspectionSummary: "Qualified after inspection.",
      },
    });

    const runInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO oneshot_runs"),
    );
    expect(runInsert?.[1]?.[1]).toBe("CPDEV-100");
    expect(getRemoteBranchHeadMock).not.toHaveBeenCalled();
    expect(prepareImplementerWorkspaceMock).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ repo_name: "core-app" }),
      "abc123",
      "oneshot/cpdev-302-run-101",
    );
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledWith(
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "core-app" }),
      "oneshot/cpdev-302-run-101",
      "abc123",
    );
  });

  it("does not reuse an existing advanced Epic branch for the next story setup", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    getRemoteBranchHeadMock.mockResolvedValue({
      branchName: "oneshot/epic/cpdev-100/master",
      headSha: "def456",
    });
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [{ insertId: 101, affectedRows: 1 }]);
    const connection = {
      query: queryMock,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };

    const service = new OneShotService(
      {
        getPool: () => pool,
      } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    await service.createQualifiedRun({
      jiraKey: "CPDEV-303",
      epicKey: "CPDEV-100",
      ticketSummary: "Qualify dependent Epic story",
      sourceTaskManagementId: 79,
      customerId: 25,
      repo: {
        id: 1,
        repo_name: "core-app",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
        default_branch: "master",
      } as any,
      branchName: "master",
      baseCommitSha: "abc123",
      qualification: {
        qualified: true,
        repoId: 1,
        branchName: "master",
        baseCommitSha: "abc123",
        requirementsSummary: ["Build on prior Epic branch work"],
        acceptanceCriteriaPresent: true,
        blockingReasons: [],
        nonBlockingWarnings: [],
        repoInspectionPerformed: true,
        inspectedFiles: ["src/example.ts"],
        inspectionSummary: "Qualified after inspection.",
      },
    });

    expect(getRemoteBranchHeadMock).not.toHaveBeenCalled();
    expect(prepareImplementerWorkspaceMock).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ repo_name: "core-app" }),
      "abc123",
      "oneshot/cpdev-303-run-101",
    );
    expect(isAncestorMock).not.toHaveBeenCalled();
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledWith(
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "core-app" }),
      "oneshot/cpdev-303-run-101",
      "abc123",
    );
    expect(publishStageMessage).toHaveBeenCalledWith(
      101,
      "planning",
      1,
      "queued_for_planning",
      false,
    );
  });

  it("fails before planning when initial run branch workspace setup fails", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    createRemoteBranchIfMissingMock.mockRejectedValueOnce(
      new Error(
        "Command failed: git ls-remote --heads https://x-access-token:secret-token@github.com/org/repo.git refs/heads/main",
      ),
    );
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [{ insertId: 101, affectedRows: 1 }]);
    const connection = {
      query: queryMock,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };

    const service = new OneShotService(
      {
        getPool: () => pool,
      } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    const result = await service.createQualifiedRun({
      jiraKey: "CPDEV-303",
      ticketSummary: "Qualify then fail setup",
      sourceTaskManagementId: 79,
      customerId: 25,
      repo: {
        id: 1,
        repo_name: "core-app",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
        default_branch: "master",
      } as any,
      branchName: "master",
      baseCommitSha: "abc123",
      qualification: {
        qualified: true,
        repoId: 1,
        branchName: "master",
        baseCommitSha: "abc123",
        requirementsSummary: ["Implement OCR status propagation"],
        acceptanceCriteriaPresent: true,
        blockingReasons: [],
        nonBlockingWarnings: [],
        repoInspectionPerformed: true,
        inspectedFiles: ["src/example.ts"],
        inspectionSummary: "Qualified after inspection.",
      },
    });

    expect(result).toEqual({
      runId: 101,
      publishError:
        "Initial run branch workspace setup failed: Command failed: git ls-remote --heads https://x-access-token:***@github.com/org/repo.git refs/heads/main",
    });
    expect(publishStageMessage).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("state = ?"),
      expect.arrayContaining([
        "failed",
        "workspace_setup_failed",
        expect.stringContaining("x-access-token:***@github.com/org/repo.git"),
        101,
      ]),
    );
  });

  it("retries the run-380 GitHub workflow-impact timeout and queues planning after recovery", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    createRemoteBranchIfMissingMock
      .mockRejectedValueOnce(new Error(RUN_380_WORKFLOW_TIMEOUT))
      .mockResolvedValueOnce({
        created: true,
        headSha: "abc123",
      });
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [{ insertId: 101, affectedRows: 1 }]);
    const connection = createConnection(queryMock);
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };

    const service = new OneShotService(
      { getPool: () => pool } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    const result = await service.createQualifiedRun(
      buildCreateQualifiedRunInput({ jiraKey: "CPDEV-380" }) as any,
    );

    expect(result).toEqual({ runId: 101 });
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledTimes(2);
    expect(publishStageMessage).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO oneshot_run_events"),
      expect.arrayContaining([
        101,
        "state_transition",
        "queued_for_planning",
        "queued_for_planning",
        "qualification",
        expect.stringContaining("post_qualification_handoff_retry"),
      ]),
    );
  });

  it("retries repo-cache lease timeout setup failures and queues planning after recovery", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    createRemoteBranchIfMissingMock
      .mockRejectedValueOnce(
        new Error("Timed out acquiring OneShot workspace lease repo-cache:core-app"),
      )
      .mockRejectedValueOnce(
        new Error("Timed out acquiring OneShot workspace lease repo-cache:core-app"),
      )
      .mockResolvedValueOnce({
        created: true,
        headSha: "abc123",
      });
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [{ insertId: 101, affectedRows: 1 }]);
    const connection = createConnection(queryMock);
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };
    const service = new OneShotService(
      { getPool: () => pool } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    const result = await service.createQualifiedRun(
      buildCreateQualifiedRunInput({ jiraKey: "CPSUP-49865" }) as any,
    );

    expect(result).toEqual({ runId: 101 });
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledTimes(3);
    expect(publishStageMessage).toHaveBeenCalledTimes(1);
  });

  it("writes workspace_setup_failed and exhaustion event when setup retries are exhausted", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    createRemoteBranchIfMissingMock.mockRejectedValue(
      new Error("Timed out acquiring OneShot workspace lease repo-cache:core-app"),
    );
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [{ insertId: 101, affectedRows: 1 }]);
    const connection = createConnection(queryMock);
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };
    const service = new OneShotService(
      { getPool: () => pool } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    const result = await service.createQualifiedRun(
      buildCreateQualifiedRunInput({ jiraKey: "CPSUP-49865" }) as any,
    );

    expect(result.publishError).toContain(
      "Initial run branch workspace setup failed",
    );
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledTimes(3);
    expect(publishStageMessage).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO oneshot_run_events"),
      expect.arrayContaining([
        101,
        "state_transition",
        "queued_for_planning",
        "queued_for_planning",
        "qualification",
        expect.stringContaining("post_qualification_handoff_retry_exhausted"),
      ]),
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("state = ?"),
      expect.arrayContaining(["failed", "workspace_setup_failed"]),
    );
  });

  it("writes planning_publish_failed after publish retries are exhausted", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [{ insertId: 101, affectedRows: 1 }]);
    const connection = createConnection(queryMock);
    const publishStageMessage = vi
      .fn()
      .mockRejectedValue(new Error("ETIMEDOUT connecting to SQS endpoint"));
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };
    const service = new OneShotService(
      { getPool: () => pool } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    const result = await service.createQualifiedRun(
      buildCreateQualifiedRunInput({ jiraKey: "CPDEV-390" }) as any,
    );

    expect(result.publishError).toBe("ETIMEDOUT connecting to SQS endpoint");
    expect(publishStageMessage).toHaveBeenCalledTimes(3);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("state = ?"),
      expect.arrayContaining(["failed", "planning_publish_failed"]),
    );
  });

  it("does not write planning_publish_exhausted event when planner already claimed the run", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const queryMock = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (
        sql.includes("WHERE id = ? AND state = ?") &&
        Array.isArray(params) &&
        params.includes("planning_publish_failed")
      ) {
        return [{ insertId: 101, affectedRows: 0 }];
      }
      return [{ insertId: 101, affectedRows: 1 }];
    });
    const connection = createConnection(queryMock);
    const publishStageMessage = vi
      .fn()
      .mockRejectedValue(new Error("ETIMEDOUT connecting to SQS endpoint"));
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };
    const service = new OneShotService(
      { getPool: () => pool } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    await service.createQualifiedRun(
      buildCreateQualifiedRunInput({ jiraKey: "CPDEV-391" }) as any,
    );

    const eventPayloads = queryMock.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO oneshot_run_events"))
      .map(([, params]) => String((params as unknown[])[5]));
    expect(
      eventPayloads.some((payload) =>
        payload.includes("planning_publish_exhausted"),
      ),
    ).toBe(false);
  });
});

describe("OneShotService queueReplanRun", () => {
  afterEach(() => {
    prepareImplementerWorkspaceMock.mockClear();
    prepareImplementerWorkspaceMock.mockResolvedValue({
      workspacePath: "/tmp/oneshot-workspace",
      statePath: "/tmp/oneshot-state",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    createRemoteBranchIfMissingMock.mockClear();
    createRemoteBranchIfMissingMock.mockResolvedValue({
      created: true,
      headSha: "abc123",
    });
    getRemoteBranchHeadMock.mockClear();
    getRemoteBranchHeadMock.mockResolvedValue(null);
    pushBranchMock.mockClear();
    pushBranchMock.mockResolvedValue(undefined);
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS =
      ORIGINAL_ONESHOT_HANDOFF_RETRY_DELAYS_MS;
  });

  it("queues failed runs for same-run planning instead of requiring replan_required", async () => {
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const failedRun = buildRunRow({
      id: 640,
      state: "failed",
      jira_key: "CPDEV-22946",
      repo_id: 1,
      branch_name: "master",
      base_commit_sha: "old-base-sha",
      run_branch_name: "oneshot/cpdev-22946-run-640",
      run_branch_base_sha: "old-base-sha",
      final_disposition: "implementation_blocked",
      last_error: "Plan was wrong",
      current_plan_version: 2,
      current_review_version: 2,
      current_implementation_version: 1,
      current_implementation_branch: "oneshot/cpdev-22946-run-640",
      current_implementation_commit_sha: "candidate-sha",
      current_code_review_version: 1,
      current_test_version: null,
      current_pr_url: null,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[failedRun]];
      }
      if (
        sql.includes("SELECT id") &&
        sql.includes("FROM oneshot_run_events")
      ) {
        return [[]];
      }
      if (sql.includes("WHERE id IN (?)")) {
        return [[]];
      }
      if (
        sql.includes("FROM oneshot_candidate_versions") &&
        sql.includes("status = 'current'")
      ) {
        return [[{
          oneshot_run_id: 640,
          candidate_version: 1,
          candidate_commit_sha: "candidate-sha",
          previous_candidate_commit_sha: null,
          status: "current",
          superseded_by_candidate_version: null,
          target_files_json: "[]",
          metadata_json: "{}",
          finalized_at: null,
        }]];
      }
      return [{ insertId: 640, affectedRows: 1 }];
    });
    const connection = createConnection(queryMock);
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    getRemoteBranchHeadMock.mockResolvedValue({
      branchName: "oneshot/cpdev-22946-run-640",
      headSha: "candidate-sha",
    });
    const service = new OneShotService(
      {
        getPool: () => ({
          query: queryMock,
          getConnection: vi.fn().mockResolvedValue(connection),
        }),
        getRepositoryById: vi.fn().mockResolvedValue({
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          default_branch: "master",
        }),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    const result = await service.queueReplanRun(
      failedRun as any,
      "new-base-sha",
    );

    expect(result).toEqual({
      state: "queued_for_planning",
      nextPlanVersion: 3,
    });
    expect(pushBranchMock).toHaveBeenCalledWith(
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "core-app" }),
      "oneshot/cpdev-22946-run-640",
      { expectedRemoteHeadSha: "candidate-sha" },
    );
    expect(publishStageMessage).toHaveBeenCalledWith(
      640,
      "planning",
      3,
      "queued_for_planning",
      true,
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE oneshot_candidate_versions"),
      [640],
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("state = ?"),
      expect.arrayContaining([
        "queued_for_planning",
        "new-base-sha",
        "new-base-sha",
        null,
        null,
        null,
        null,
        null,
        0,
        0,
        0,
        0,
        0,
        null,
        "replan_requested",
        640,
        "failed",
      ]),
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO oneshot_run_events"),
      expect.arrayContaining([
        640,
        "control_replan_requested",
        "failed",
        "queued_for_planning",
        "qualification",
        expect.stringContaining("pfos_replan_label"),
      ]),
    );
  });

  it("does not queue another replan when the prior PFOS-REPLAN label cleanup failed", async () => {
    const blockedRun = buildRunRow({
      id: 641,
      state: "blocked",
      jira_key: "CPDEV-22946",
      current_plan_version: 3,
      current_pr_url: null,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[blockedRun]];
      }
      if (sql.includes("WHERE id IN (?)")) {
        return [[
          {
            id: 1,
            oneshot_run_id: 641,
            event_type: "control_replan_requested",
            from_state: "failed",
            to_state: "queued_for_planning",
            stage: "qualification",
            metadata_json: JSON.stringify({
              runId: 641,
              nextPlanVersion: 3,
              sourceLabel: "PFOS-REPLAN",
            }),
            occurred_at: new Date("2026-06-30T10:00:00.000Z"),
          },
          {
            id: 2,
            oneshot_run_id: 641,
            event_type: "replan_label_cleanup_failed",
            from_state: "queued_for_planning",
            to_state: "queued_for_planning",
            stage: "qualification",
            metadata_json: JSON.stringify({
              reason: "pfos_replan_queued",
            }),
            occurred_at: new Date("2026-06-30T10:01:00.000Z"),
          },
        ]];
      }
      if (
        sql.includes("SELECT id") &&
        sql.includes("FROM oneshot_run_events")
      ) {
        return [[{ id: 1 }, { id: 2 }]];
      }
      return [{ insertId: 641, affectedRows: 1 }];
    });
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById: vi.fn(),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    const result = await service.queueReplanRun(
      blockedRun as any,
      "new-base-sha",
    );

    expect(result).toEqual({
      state: "blocked",
      nextPlanVersion: 4,
      skipped: true,
      noActionReason: "replan_label_cleanup_pending",
    });
    expect(prepareImplementerWorkspaceMock).not.toHaveBeenCalled();
    expect(pushBranchMock).not.toHaveBeenCalled();
    expect(publishStageMessage).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO oneshot_run_events"),
      expect.arrayContaining([
        641,
        "control_replan_noop",
        "blocked",
        "blocked",
        "qualification",
        expect.stringContaining("replan_label_cleanup_pending"),
      ]),
    );
  });

  it("allows a later PFOS-REPLAN after the stale label removal was observed", async () => {
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const blockedRun = buildRunRow({
      id: 643,
      state: "blocked",
      jira_key: "CPDEV-22946",
      repo_id: 1,
      branch_name: "master",
      base_commit_sha: "old-base-sha",
      run_branch_name: "oneshot/cpdev-22946-run-643",
      run_branch_base_sha: "old-base-sha",
      current_plan_version: 3,
      current_pr_url: null,
    });
    const replanEvents = [
      {
        id: 1,
        oneshot_run_id: 643,
        event_type: "control_replan_requested",
        from_state: "failed",
        to_state: "queued_for_planning",
        stage: "qualification",
        metadata_json: JSON.stringify({
          runId: 643,
          nextPlanVersion: 3,
          sourceLabel: "PFOS-REPLAN",
        }),
        occurred_at: new Date("2026-06-30T10:00:00.000Z"),
      },
      {
        id: 2,
        oneshot_run_id: 643,
        event_type: "replan_label_cleanup_failed",
        from_state: "queued_for_planning",
        to_state: "queued_for_planning",
        stage: "qualification",
        metadata_json: JSON.stringify({
          reason: "pfos_replan_queued",
        }),
        occurred_at: new Date("2026-06-30T10:01:00.000Z"),
      },
      {
        id: 3,
        oneshot_run_id: 643,
        event_type: "replan_label_cleanup_observed",
        from_state: "blocked",
        to_state: "blocked",
        stage: "qualification",
        metadata_json: JSON.stringify({
          reason: "pfos_replan_label_absent",
        }),
        occurred_at: new Date("2026-06-30T10:05:00.000Z"),
      },
    ];
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[blockedRun]];
      }
      if (
        sql.includes("SELECT id") &&
        sql.includes("FROM oneshot_run_events")
      ) {
        return [[{ id: 1 }, { id: 2 }, { id: 3 }]];
      }
      if (sql.includes("WHERE id IN (?)")) {
        return [[...replanEvents]];
      }
      if (sql.includes("FROM oneshot_candidate_versions")) {
        return [[]];
      }
      return [{ insertId: 643, affectedRows: 1 }];
    });
    const connection = createConnection(queryMock);
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const service = new OneShotService(
      {
        getPool: () => ({
          query: queryMock,
          getConnection: vi.fn().mockResolvedValue(connection),
        }),
        getRepositoryById: vi.fn().mockResolvedValue({
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          default_branch: "master",
        }),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    const result = await service.queueReplanRun(
      blockedRun as any,
      "new-base-sha",
    );

    expect(result).toEqual({
      state: "queued_for_planning",
      nextPlanVersion: 4,
    });
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledWith(
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "core-app" }),
      "oneshot/cpdev-22946-run-643",
      "new-base-sha",
    );
    expect(publishStageMessage).toHaveBeenCalledWith(
      643,
      "planning",
      4,
      "queued_for_planning",
      true,
    );
  });

  it("normalizes legacy shared Epic handoff rows before PFOS-REPLAN queues planning", async () => {
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const failedRun = buildRunRow({
      id: 642,
      state: "failed",
      jira_key: "CPDEV-22946",
      epic_key: "CPDEV-22942",
      repo_id: 1,
      branch_name: "master",
      base_commit_sha: "old-base-sha",
      run_branch_name: "oneshot/epic/cpdev-22942/master",
      run_branch_base_sha: "advanced-epic-sha",
      final_disposition: "workspace_setup_failed",
      current_plan_version: null,
      current_review_version: null,
      current_implementation_version: null,
      current_implementation_branch: "oneshot/epic/cpdev-22942/master",
      current_implementation_commit_sha: null,
      current_code_review_version: null,
      current_test_version: null,
      current_pr_url: null,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[failedRun]];
      }
      if (
        sql.includes("SELECT id") &&
        sql.includes("FROM oneshot_run_events")
      ) {
        return [[]];
      }
      if (sql.includes("WHERE id IN (?)")) {
        return [[]];
      }
      if (sql.includes("FROM oneshot_candidate_versions")) {
        return [[]];
      }
      return [{ insertId: 642, affectedRows: 1 }];
    });
    const connection = createConnection(queryMock);
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const service = new OneShotService(
      {
        getPool: () => ({
          query: queryMock,
          getConnection: vi.fn().mockResolvedValue(connection),
        }),
        getRepositoryById: vi.fn().mockResolvedValue({
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          default_branch: "master",
        }),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    const result = await service.queueReplanRun(
      failedRun as any,
      "new-base-sha",
    );

    expect(result).toEqual({
      state: "queued_for_planning",
      nextPlanVersion: 1,
    });
    expect(prepareImplementerWorkspaceMock).toHaveBeenCalledWith(
      642,
      expect.objectContaining({ repo_name: "core-app" }),
      "new-base-sha",
      "oneshot/cpdev-22946-run-642",
    );
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledWith(
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "core-app" }),
      "oneshot/cpdev-22946-run-642",
      "new-base-sha",
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("run_branch_name = ?"),
      expect.arrayContaining([
        "oneshot/cpdev-22946-run-642",
        "new-base-sha",
        642,
      ]),
    );
    expect(publishStageMessage).toHaveBeenCalledWith(
      642,
      "planning",
      1,
      "queued_for_planning",
      true,
    );
  });
});

describe("OneShotService recoverPlanningHandoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    prepareImplementerWorkspaceMock.mockClear();
    prepareImplementerWorkspaceMock.mockResolvedValue({
      workspacePath: "/tmp/oneshot-workspace",
      statePath: "/tmp/oneshot-state",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    createRemoteBranchIfMissingMock.mockClear();
    createRemoteBranchIfMissingMock.mockResolvedValue({
      created: true,
      headSha: "abc123",
    });
    getRemoteBranchHeadMock.mockClear();
    getRemoteBranchHeadMock.mockResolvedValue(null);
    isAncestorMock.mockClear();
    isAncestorMock.mockResolvedValue(true);
    pushBranchMock.mockClear();
    pushBranchMock.mockResolvedValue(undefined);
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS =
      ORIGINAL_ONESHOT_HANDOFF_RETRY_DELAYS_MS;
  });

  it("recovers workspace_setup_failed runs and publishes planning with recovery dedupe", async () => {
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const failedRun = buildRunRow({
      id: 380,
      state: "failed",
      jira_key: "CPDEV-23753",
      repo_id: 1,
      branch_name: "medhok-monorepo-4.0",
      base_commit_sha: "base-sha",
      run_branch_name: "oneshot/cpdev-23753-run-380",
      run_branch_base_sha: "base-sha",
      final_disposition: "workspace_setup_failed",
      last_error: "Initial run branch workspace setup failed",
      current_plan_version: null,
      current_review_version: null,
      current_implementation_version: null,
      current_code_review_version: null,
      current_test_version: null,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[failedRun]];
      }
      if (sql.includes("FROM oneshot_candidate_versions")) {
        return [[]];
      }
      return [{ insertId: 501, affectedRows: 1 }];
    });
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const pool = { query: queryMock };
    const service = new OneShotService(
      {
        getPool: () => pool,
        getRepositoryById: vi.fn().mockResolvedValue({
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          default_branch: "master",
        }),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    const result = await service.recoverPlanningHandoff({
      runId: 380,
      operatorId: "operator-1",
      operatorName: "Operator One",
      reason: "Retry after GitHub timeout",
    });

    expect(result).toEqual({
      oneshotRunId: 380,
      stage: "planning",
      state: "queued_for_planning",
      version: 1,
    });
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledWith(
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "core-app" }),
      "oneshot/cpdev-23753-run-380",
      "base-sha",
    );
    expect(publishStageMessage).toHaveBeenCalledWith(
      380,
      "planning",
      1,
      "queued_for_planning",
      false,
      expect.objectContaining({
        dedupeToken: expect.stringContaining("handoff-recovery:"),
      }),
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("state = ?"),
      expect.arrayContaining(["queued_for_planning", null, null, 380, "failed"]),
    );
  });

  it("normalizes failed pre-planning shared Epic branches during handoff recovery", async () => {
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const failedRun = buildRunRow({
      id: 605,
      state: "failed",
      jira_key: "CPDEV-25292",
      epic_key: "CPDEV-23145",
      repo_id: 1,
      branch_name: "master",
      base_commit_sha: "base-sha",
      run_branch_name: "oneshot/epic/cpdev-23145/master",
      run_branch_base_sha: "advanced-epic-sha",
      final_disposition: "workspace_setup_failed",
      last_error: "Initial run branch workspace setup failed",
      current_plan_version: null,
      current_review_version: null,
      current_implementation_version: null,
      current_implementation_branch: "oneshot/epic/cpdev-23145/master",
      current_implementation_commit_sha: null,
      current_code_review_version: null,
      current_test_version: null,
      current_pr_url: null,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[failedRun]];
      }
      if (sql.includes("FROM oneshot_candidate_versions")) {
        return [[]];
      }
      return [{ insertId: 503, affectedRows: 1 }];
    });
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const pool = { query: queryMock };
    const service = new OneShotService(
      {
        getPool: () => pool,
        getRepositoryById: vi.fn().mockResolvedValue({
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          default_branch: "master",
        }),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    const result = await service.recoverPlanningHandoff({
      runId: 605,
      operatorId: "operator-1",
      operatorName: "Operator One",
      reason: "Retry after shared Epic branch collision",
    });

    expect(result.oneshotRunId).toBe(605);
    expect(getRemoteBranchHeadMock).not.toHaveBeenCalled();
    expect(prepareImplementerWorkspaceMock).toHaveBeenCalledWith(
      605,
      expect.objectContaining({ repo_name: "core-app" }),
      "base-sha",
      "oneshot/cpdev-25292-run-605",
    );
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledWith(
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "core-app" }),
      "oneshot/cpdev-25292-run-605",
      "base-sha",
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("run_branch_name = ?"),
      expect.arrayContaining(["oneshot/cpdev-25292-run-605", "base-sha", 605]),
    );
  });

  it("normalizes shared Epic branches before recovering planning publish failures", async () => {
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const failedRun = buildRunRow({
      id: 606,
      state: "failed",
      jira_key: "CPDEV-25293",
      epic_key: "CPDEV-23145",
      repo_id: 1,
      branch_name: "master",
      base_commit_sha: "base-sha",
      run_branch_name: "oneshot/epic/cpdev-23145/master",
      run_branch_base_sha: "advanced-epic-sha",
      final_disposition: "planning_publish_failed",
      last_error: "Planning publish failed after shared Epic setup",
      current_plan_version: null,
      current_review_version: null,
      current_implementation_version: null,
      current_implementation_branch: "oneshot/epic/cpdev-23145/master",
      current_implementation_commit_sha: null,
      current_code_review_version: null,
      current_test_version: null,
      current_pr_url: null,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[failedRun]];
      }
      if (sql.includes("FROM oneshot_candidate_versions")) {
        return [[]];
      }
      return [{ insertId: 504, affectedRows: 1 }];
    });
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const getRepositoryById = vi.fn().mockResolvedValue({
      id: 1,
      repo_name: "core-app",
      repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      default_branch: "master",
    });
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById,
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    const result = await service.recoverPlanningHandoff({
      runId: 606,
      operatorId: "operator-1",
      operatorName: "Operator One",
      reason: "Retry after publish failure on shared Epic branch",
    });

    expect(result.oneshotRunId).toBe(606);
    expect(getRepositoryById).toHaveBeenCalledWith(1);
    expect(getRemoteBranchHeadMock).not.toHaveBeenCalled();
    expect(prepareImplementerWorkspaceMock).toHaveBeenCalledWith(
      606,
      expect.objectContaining({ repo_name: "core-app" }),
      "base-sha",
      "oneshot/cpdev-25293-run-606",
    );
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledWith(
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "core-app" }),
      "oneshot/cpdev-25293-run-606",
      "base-sha",
    );
    expect(publishStageMessage).toHaveBeenCalledWith(
      606,
      "planning",
      1,
      "queued_for_planning",
      false,
      expect.objectContaining({
        dedupeToken: expect.stringContaining("handoff-recovery:606:"),
      }),
    );
  });

  it("rejects shared Epic handoff recovery when a current candidate exists", async () => {
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const failedRun = buildRunRow({
      id: 607,
      state: "failed",
      jira_key: "CPDEV-25294",
      epic_key: "CPDEV-23145",
      repo_id: 1,
      branch_name: "master",
      base_commit_sha: "base-sha",
      run_branch_name: "oneshot/epic/cpdev-23145/master",
      run_branch_base_sha: "advanced-epic-sha",
      final_disposition: "planning_publish_failed",
      last_error: "Planning publish failed after shared Epic setup",
      current_plan_version: null,
      current_review_version: null,
      current_implementation_version: null,
      current_implementation_branch: "oneshot/epic/cpdev-23145/master",
      current_implementation_commit_sha: null,
      current_code_review_version: null,
      current_test_version: null,
      current_pr_url: null,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[failedRun]];
      }
      if (sql.includes("FROM oneshot_candidate_versions")) {
        return [[{
          oneshot_run_id: 607,
          candidate_version: 1,
          candidate_commit_sha: "candidate-sha",
          previous_candidate_commit_sha: null,
          status: "current",
          superseded_by_candidate_version: null,
          target_files_json: "[]",
          metadata_json: "{}",
          finalized_at: null,
        }]];
      }
      return [{ insertId: 505, affectedRows: 1 }];
    });
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById: vi.fn(),
      } as any,
      { publishStageMessage: vi.fn() } as any,
      { send: vi.fn() } as any,
    );

    await expect(
      service.recoverPlanningHandoff({
        runId: 607,
        operatorId: "operator-1",
        operatorName: "Operator One",
      }),
    ).rejects.toThrow(
      "recover it manually because it is no longer a pre-planning handoff-only run",
    );

    expect(prepareImplementerWorkspaceMock).not.toHaveBeenCalled();
    expect(createRemoteBranchIfMissingMock).not.toHaveBeenCalled();
  });

  it("recovers planning_publish_failed runs without rerunning workspace setup", async () => {
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const failedRun = buildRunRow({
      id: 381,
      state: "failed",
      jira_key: "CPDEV-23754",
      repo_id: 1,
      branch_name: "medhok-monorepo-4.0",
      base_commit_sha: "base-sha",
      run_branch_name: "oneshot/cpdev-23754-run-381",
      run_branch_base_sha: "base-sha",
      final_disposition: "planning_publish_failed",
      last_error: "ETIMEDOUT connecting to SQS endpoint",
      current_plan_version: null,
      current_review_version: null,
      current_implementation_version: null,
      current_code_review_version: null,
      current_test_version: null,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[failedRun]];
      }
      if (sql.includes("FROM oneshot_candidate_versions")) {
        return [[]];
      }
      return [{ insertId: 502, affectedRows: 1 }];
    });
    const getRepositoryById = vi.fn();
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById,
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    const result = await service.recoverPlanningHandoff({
      runId: 381,
      operatorId: "operator-1",
      operatorName: "Operator One",
      reason: "Retry publish handoff",
    });

    expect(result).toEqual({
      oneshotRunId: 381,
      stage: "planning",
      state: "queued_for_planning",
      version: 1,
    });
    expect(getRepositoryById).not.toHaveBeenCalled();
    expect(createRemoteBranchIfMissingMock).not.toHaveBeenCalled();
    expect(publishStageMessage).toHaveBeenCalledWith(
      381,
      "planning",
      1,
      "queued_for_planning",
      false,
      expect.objectContaining({
        dedupeToken: expect.stringContaining("handoff-recovery:381:"),
      }),
    );
  });

  it("rejects non-handoff failed runs", async () => {
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[buildRunRow({
          id: 401,
          state: "failed",
          final_disposition: "run_failed",
        })]];
      }
      return [{ affectedRows: 1 }];
    });
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById: vi.fn(),
      } as any,
      { publishStageMessage: vi.fn() } as any,
      { send: vi.fn() } as any,
    );

    await expect(
      service.recoverPlanningHandoff({
        runId: 401,
        operatorId: "operator-1",
        operatorName: "Operator One",
      }),
    ).rejects.toThrow("not a qualification-to-planning handoff failure");
  });

  it("marks recovery publish failures back to planning_publish_failed", async () => {
    process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS = "0,0,0";
    const failedRun = buildRunRow({
      id: 402,
      state: "failed",
      final_disposition: "planning_publish_failed",
      current_plan_version: null,
      current_review_version: null,
      current_implementation_version: null,
      current_code_review_version: null,
      current_test_version: null,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[failedRun]];
      }
      if (sql.includes("FROM oneshot_candidate_versions")) {
        return [[]];
      }
      return [{ insertId: 601, affectedRows: 1 }];
    });
    const publishStageMessage = vi
      .fn()
      .mockRejectedValue(new Error("ETIMEDOUT connecting to SQS endpoint"));
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById: vi.fn().mockResolvedValue({
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          default_branch: "master",
        }),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    await expect(
      service.recoverPlanningHandoff({
        runId: 402,
        operatorId: "operator-1",
        operatorName: "Operator One",
      }),
    ).rejects.toThrow("ETIMEDOUT connecting to SQS endpoint");
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("state = ?"),
      expect.arrayContaining(["failed", "planning_publish_failed"]),
    );
  });
});

describe("OneShotService recoverPlanContractViolation", () => {
  it("recovers blocked plan-contract violations and publishes planning with recovery dedupe", async () => {
    const blockedRun = buildRunRow({
      id: 546,
      state: "blocked",
      jira_key: "CPDEV-25333",
      final_disposition: "implementation_blocked",
      last_error:
        "Implementation changed files outside the approved plan contract: src/oneshot/consumers/tester.ts.",
      current_plan_version: 7,
      current_review_version: 7,
      current_implementation_version: 6,
      current_implementation_branch: "oneshot/cpdev-25333-run-546",
      current_implementation_commit_sha: null,
      current_code_review_version: 4,
      current_test_version: null,
      review_loop_count: 2,
      planning_attempt_count: 1,
      implementation_attempt_count: 1,
      code_review_attempt_count: 1,
      verification_loop_count: 0,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[blockedRun]];
      }
      if (sql.includes("event_type IN ('state_transition', 'state_revert')")) {
        return [[
          {
            id: 901,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "blocked",
            metadata_json: JSON.stringify({
              reason: "plan_contract_violation",
              version: 6,
              revision: true,
              editableFiles: ["src/oneshot/consumers/implementer.ts"],
              changedFiles: [
                "src/oneshot/consumers/implementer.ts",
                "src/oneshot/consumers/tester.ts",
              ],
              violatingFiles: ["src/oneshot/consumers/tester.ts"],
            }),
          },
        ]];
      }
      if (
        sql.includes("FROM oneshot_run_events") &&
        sql.includes("plan_contract_violation")
      ) {
        return [[
          {
            id: 901,
            metadata_json: JSON.stringify({
              reason: "plan_contract_violation",
              version: 6,
              revision: true,
              editableFiles: ["src/oneshot/consumers/implementer.ts"],
              changedFiles: [
                "src/oneshot/consumers/implementer.ts",
                "src/oneshot/consumers/tester.ts",
              ],
              violatingFiles: ["src/oneshot/consumers/tester.ts"],
            }),
          },
        ]];
      }
      return [{ insertId: 701, affectedRows: 1 }];
    });
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById: vi.fn(),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    const result = await service.recoverPlanContractViolation({
      runId: 546,
      operatorId: "operator-1",
      operatorName: "Operator One",
      reason: "Recover run-546",
    });

    expect(result).toEqual({
      oneshotRunId: 546,
      stage: "planning",
      state: "queued_for_planning",
      version: 8,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("state = ?"),
      expect.arrayContaining([
        "queued_for_planning",
        8,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        0,
        0,
        0,
        0,
        null,
        null,
        546,
        "blocked",
      ]),
    );
    const recoveryEventInsert = queryMock.mock.calls.find(([sql, params]) => {
      const values = params as unknown[] | undefined;
      return (
        String(sql).includes("INSERT INTO oneshot_run_events") &&
        values?.[1] === "state_transition" &&
        values?.[2] === "blocked" &&
        values?.[3] === "queued_for_planning"
      );
    });
    expect(recoveryEventInsert).toBeDefined();
    const recoveryEventMetadata = JSON.parse(
      String((recoveryEventInsert?.[1] as unknown[])[5]),
    );
    expect(recoveryEventMetadata).toMatchObject({
      reason: "manual_plan_contract_violation_recovery",
      version: 6,
      revision: true,
      currentPlanVersion: 7,
      nextPlanVersion: 8,
      editableFiles: ["src/oneshot/consumers/implementer.ts"],
      changedFiles: [
        "src/oneshot/consumers/implementer.ts",
        "src/oneshot/consumers/tester.ts",
      ],
      violatingFiles: ["src/oneshot/consumers/tester.ts"],
    });
    expect(publishStageMessage).toHaveBeenCalledWith(
      546,
      "planning",
      8,
      "queued_for_planning",
      true,
      expect.objectContaining({
        dedupeToken: expect.stringContaining("plan-contract-recovery:546:"),
      }),
    );
  });

  it("rejects blocked runs without a plan-contract violation event", async () => {
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[
          buildRunRow({
            id: 547,
            state: "blocked",
            final_disposition: "implementation_blocked",
          }),
        ]];
      }
      if (sql.includes("event_type IN ('state_transition', 'state_revert')")) {
        return [[]];
      }
      if (sql.includes("FROM oneshot_run_events")) {
        return [[]];
      }
      return [{ affectedRows: 1 }];
    });
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById: vi.fn(),
      } as any,
      { publishStageMessage: vi.fn() } as any,
      { send: vi.fn() } as any,
    );

    await expect(
      service.recoverPlanContractViolation({
        runId: 547,
        operatorId: "operator-1",
        operatorName: "Operator One",
      }),
    ).rejects.toThrow("not a blocked plan-contract violation");
  });

  it("rejects recovery when a newer blocked implementation transition is not plan-contract related", async () => {
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[
          buildRunRow({
            id: 550,
            state: "blocked",
            final_disposition: "implementation_blocked",
          }),
        ]];
      }
      if (sql.includes("event_type IN ('state_transition', 'state_revert')")) {
        return [[
          {
            id: 905,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "blocked",
            metadata_json: JSON.stringify({
              reason: "implementation_disagreed_with_review",
            }),
          },
        ]];
      }
      if (
        sql.includes("FROM oneshot_run_events") &&
        sql.includes("plan_contract_violation")
      ) {
        return [[
          {
            id: 904,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "blocked",
            metadata_json: JSON.stringify({
              reason: "plan_contract_violation",
              violatingFiles: ["src/oneshot/consumers/tester.ts"],
            }),
          },
        ]];
      }
      return [{ affectedRows: 1 }];
    });
    const publishStageMessage = vi.fn();
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById: vi.fn(),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    await expect(
      service.recoverPlanContractViolation({
        runId: 550,
        operatorId: "operator-1",
        operatorName: "Operator One",
      }),
    ).rejects.toThrow("not a blocked plan-contract violation");
    expect(publishStageMessage).not.toHaveBeenCalled();
  });

  it("allows retry after a previous manual recovery publish failure reverted to blocked", async () => {
    const blockedRun = buildRunRow({
      id: 551,
      state: "blocked",
      jira_key: "CPDEV-25333",
      final_disposition: "implementation_blocked",
      last_error: "sqs unavailable",
      current_plan_version: 4,
      current_implementation_version: 3,
    });
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[blockedRun]];
      }
      if (sql.includes("event_type IN ('state_transition', 'state_revert')")) {
        return [[
          {
            id: 907,
            event_type: "state_revert",
            from_state: "queued_for_planning",
            to_state: "blocked",
            metadata_json: JSON.stringify({
              reason: "manual_plan_contract_violation_recovery_publish_failed",
            }),
          },
        ]];
      }
      if (
        sql.includes("FROM oneshot_run_events") &&
        sql.includes("plan_contract_violation")
      ) {
        return [[
          {
            id: 906,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "blocked",
            metadata_json: JSON.stringify({
              reason: "plan_contract_violation",
              version: 3,
              revision: true,
              editableFiles: ["src/oneshot/consumers/implementer.ts"],
              changedFiles: [
                "src/oneshot/consumers/implementer.ts",
                "src/oneshot/consumers/tester.ts",
              ],
              violatingFiles: ["src/oneshot/consumers/tester.ts"],
            }),
          },
        ]];
      }
      return [{ insertId: 703, affectedRows: 1 }];
    });
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById: vi.fn(),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    const result = await service.recoverPlanContractViolation({
      runId: 551,
      operatorId: "operator-1",
      operatorName: "Operator One",
    });

    expect(result).toEqual({
      oneshotRunId: 551,
      stage: "planning",
      state: "queued_for_planning",
      version: 5,
    });
    expect(publishStageMessage).toHaveBeenCalledWith(
      551,
      "planning",
      5,
      "queued_for_planning",
      true,
      expect.objectContaining({
        dedupeToken: expect.stringContaining("plan-contract-recovery:551:"),
      }),
    );
  });

  it("reverts manual recovery when the recovery event cannot be written", async () => {
    const blockedRun = buildRunRow({
      id: 549,
      state: "blocked",
      jira_key: "CPDEV-25333",
      final_disposition: "implementation_blocked",
      last_error:
        "Implementation changed files outside the approved plan contract: src/oneshot/consumers/tester.ts.",
      current_plan_version: 3,
      current_review_version: 3,
      current_implementation_version: 2,
      current_implementation_branch: "oneshot/cpdev-25333-run-549",
      current_code_review_version: 1,
      review_loop_count: 1,
      planning_attempt_count: 1,
      implementation_attempt_count: 1,
      code_review_attempt_count: 1,
    });
    let eventInsertCount = 0;
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[blockedRun]];
      }
      if (sql.includes("event_type IN ('state_transition', 'state_revert')")) {
        return [[
          {
            id: 903,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "blocked",
            metadata_json: JSON.stringify({
              reason: "plan_contract_violation",
              version: 2,
              revision: true,
              editableFiles: ["src/oneshot/consumers/implementer.ts"],
              changedFiles: [
                "src/oneshot/consumers/implementer.ts",
                "src/oneshot/consumers/tester.ts",
              ],
              violatingFiles: ["src/oneshot/consumers/tester.ts"],
            }),
          },
        ]];
      }
      if (
        sql.includes("FROM oneshot_run_events") &&
        sql.includes("plan_contract_violation")
      ) {
        return [[
          {
            id: 903,
            metadata_json: JSON.stringify({
              reason: "plan_contract_violation",
              version: 2,
              revision: true,
              editableFiles: ["src/oneshot/consumers/implementer.ts"],
              changedFiles: [
                "src/oneshot/consumers/implementer.ts",
                "src/oneshot/consumers/tester.ts",
              ],
              violatingFiles: ["src/oneshot/consumers/tester.ts"],
            }),
          },
        ]];
      }
      if (sql.includes("INSERT INTO oneshot_run_events")) {
        eventInsertCount += 1;
        if (eventInsertCount === 1) {
          throw new Error("event store unavailable");
        }
      }
      return [{ insertId: 702, affectedRows: 1 }];
    });
    const publishStageMessage = vi.fn();
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById: vi.fn(),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    await expect(
      service.recoverPlanContractViolation({
        runId: 549,
        operatorId: "operator-1",
        operatorName: "Operator One",
      }),
    ).rejects.toThrow("event store unavailable");

    expect(publishStageMessage).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("state = ?"),
      expect.arrayContaining([
        "blocked",
        3,
        3,
        2,
        "oneshot/cpdev-25333-run-549",
        1,
        1,
        1,
        1,
        "implementation_blocked",
        "event store unavailable",
        549,
        "queued_for_planning",
      ]),
    );
    const revertEventInsert = queryMock.mock.calls.find(([sql, params]) => {
      const values = params as unknown[] | undefined;
      return (
        String(sql).includes("INSERT INTO oneshot_run_events") &&
        values?.[1] === "state_revert" &&
        values?.[2] === "queued_for_planning" &&
        values?.[3] === "blocked"
      );
    });
    expect(revertEventInsert).toBeDefined();
    const revertMetadata = JSON.parse(
      String((revertEventInsert?.[1] as unknown[])[5]),
    );
    expect(revertMetadata).toMatchObject({
      reason: "manual_plan_contract_violation_recovery_event_failed",
      recoveryError: "event store unavailable",
      nextPlanVersion: 4,
    });
  });

  it("rejects plan-contract recovery when violation metadata has no files", async () => {
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[
          buildRunRow({
            id: 548,
            state: "blocked",
            final_disposition: "implementation_blocked",
          }),
        ]];
      }
      if (sql.includes("event_type IN ('state_transition', 'state_revert')")) {
        return [[
          {
            id: 902,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "blocked",
            metadata_json: JSON.stringify({
              reason: "plan_contract_violation",
              violatingFiles: [],
            }),
          },
        ]];
      }
      if (sql.includes("FROM oneshot_run_events")) {
        return [[
          {
            id: 902,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "blocked",
            metadata_json: JSON.stringify({
              reason: "plan_contract_violation",
              violatingFiles: [],
            }),
          },
        ]];
      }
      return [{ affectedRows: 1 }];
    });
    const publishStageMessage = vi.fn();
    const service = new OneShotService(
      {
        getPool: () => ({ query: queryMock }),
        getRepositoryById: vi.fn(),
      } as any,
      { publishStageMessage } as any,
      { send: vi.fn() } as any,
    );

    await expect(
      service.recoverPlanContractViolation({
        runId: 548,
        operatorId: "operator-1",
        operatorName: "Operator One",
      }),
    ).rejects.toThrow("missing violating file metadata");
    expect(publishStageMessage).not.toHaveBeenCalled();
  });
});

describe("OneShotService createQualifiedRunGroup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    prepareImplementerWorkspaceMock.mockClear();
    prepareImplementerWorkspaceMock.mockResolvedValue({
      workspacePath: "/tmp/oneshot-workspace",
      statePath: "/tmp/oneshot-state",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    createRemoteBranchIfMissingMock.mockClear();
    createRemoteBranchIfMissingMock.mockResolvedValue({
      created: true,
      headSha: "abc123",
    });
    getRemoteBranchHeadMock.mockClear();
    getRemoteBranchHeadMock.mockResolvedValue(null);
    isAncestorMock.mockClear();
    isAncestorMock.mockResolvedValue(true);
    process.env.ONESHOT_ARTIFACT_BUCKET = ORIGINAL_ONESHOT_ARTIFACT_BUCKET;
  });

  it("creates linked child runs, stores qualification artifacts, and queues planning", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    const insertIds = [900, 101, 0, 1001, 102, 0, 1002];
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [
        { insertId: insertIds.shift() ?? 0, affectedRows: 1 },
      ]);
    const connection = {
      query: queryMock,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };

    const service = new OneShotService(
      {
        getPool: () => pool,
      } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    const qualification = {
      qualified: true,
      repoId: 1,
      branchName: "master",
      baseCommitSha: "abc123",
      requirementsSummary: ["Implement OCR status propagation"],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      repoInspectionPerformed: false,
      inspectedFiles: [],
      inspectionSummary: "Direct qualification.",
    };

    const result = await service.createQualifiedRunGroup({
      jiraKey: "CPDEV-300",
      epicKey: "CPDEV-100",
      ticketSummary: "Implement OCR status propagation",
      jiraIssueType: "Story",
      jiraLabels: ["PFOS"],
      sourceTaskManagementId: 77,
      customerId: 25,
      groupMetadata: {
        repoSelectionMode: "multi_repo",
      },
      runs: [
        {
          repo: {
            id: 1,
            repo_name: "core-app",
            repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
            default_branch: "master",
          } as any,
          branchName: "master",
          baseCommitSha: "abc123",
          qualification: {
            ...qualification,
            repoId: 1,
          },
          qualificationProvider: "deterministic",
          qualificationModel: "none",
        },
        {
          repo: {
            id: 8,
            repo_name: "Document-ai",
            repo_url: "https://github.com/mhk-repos/document-ai.git",
            default_branch: "main",
          } as any,
          branchName: "main",
          baseCommitSha: "def456",
          qualification: {
            ...qualification,
            repoId: 8,
            branchName: "main",
            baseCommitSha: "def456",
          },
          qualificationProvider: "deterministic",
          qualificationModel: "none",
        },
      ],
    });

    expect(result).toEqual({
      runGroupId: 900,
      runIds: [101, 102],
      publishError: undefined,
    });
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);

    const runInserts = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO oneshot_runs"),
    );
    expect(runInserts).toHaveLength(2);
    expect(runInserts[0]?.[1]?.slice(0, 11)).toEqual([
      "CPDEV-300",
      "CPDEV-100",
      "Story",
      "story",
      "jira_issue_type",
      null,
      null,
      900,
      "v2",
      77,
      25,
    ]);
    expect(runInserts[1]?.[1]?.slice(0, 11)).toEqual([
      "CPDEV-300",
      "CPDEV-100",
      "Story",
      "story",
      "jira_issue_type",
      null,
      null,
      900,
      "v2",
      77,
      25,
    ]);
    expect(prepareImplementerWorkspaceMock).toHaveBeenNthCalledWith(
      1,
      101,
      expect.objectContaining({ repo_name: "core-app" }),
      "abc123",
      "oneshot/cpdev-300-run-101",
    );
    expect(prepareImplementerWorkspaceMock).toHaveBeenNthCalledWith(
      2,
      102,
      expect.objectContaining({ repo_name: "Document-ai" }),
      "def456",
      "oneshot/cpdev-300-run-102",
    );
    expect(createRemoteBranchIfMissingMock).toHaveBeenNthCalledWith(
      1,
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "core-app" }),
      "oneshot/cpdev-300-run-101",
      "abc123",
    );
    expect(createRemoteBranchIfMissingMock).toHaveBeenNthCalledWith(
      2,
      "/tmp/oneshot-workspace",
      expect.objectContaining({ repo_name: "Document-ai" }),
      "oneshot/cpdev-300-run-102",
      "def456",
    );

    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(s3Send.mock.calls[0]?.[0].input.Key).toBe(
      "oneshot/CPDEV-300/run-101/qualification/v1/qualification.json",
    );
    expect(
      JSON.parse(String(s3Send.mock.calls[0]?.[0].input.Body)),
    ).toMatchObject({
      jiraKey: "CPDEV-300",
      repoName: "core-app",
      runGroupId: 900,
      processingMode: "standard",
      jiraIssueType: "Story",
      ticketType: "story",
      ticketTypeSource: "jira_issue_type",
    });

    expect(publishStageMessage).toHaveBeenCalledTimes(2);
    expect(publishStageMessage).toHaveBeenNthCalledWith(
      1,
      101,
      "planning",
      1,
      "queued_for_planning",
      false,
    );
    expect(publishStageMessage).toHaveBeenNthCalledWith(
      2,
      102,
      "planning",
      1,
      "queued_for_planning",
      false,
    );
  });

  it("persists multi-branch retrofit group metadata for same-repo child runs", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    const insertIds = [910, 201, 0, 2001, 202, 0, 2002];
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [
        { insertId: insertIds.shift() ?? 0, affectedRows: 1 },
      ]);
    const connection = {
      query: queryMock,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const service = new OneShotService(
      {
        getPool: () => ({
          getConnection: vi.fn().mockResolvedValue(connection),
          query: queryMock,
        }),
      } as any,
      { publishStageMessage: vi.fn().mockResolvedValue(undefined) } as any,
      { send: vi.fn().mockResolvedValue({}) } as any,
    );
    const repo = {
      id: 1,
      repo_name: "core-app",
      repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      default_branch: "master",
    } as any;
    const qualification = {
      qualified: true,
      repoId: 1,
      branchName: "medhok-monorepo-3.17",
      baseCommitSha: "abc123",
      requirementsSummary: ["Retrofit CPDEV-1234"],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      repoInspectionPerformed: false,
      inspectedFiles: [],
      inspectionSummary: "Direct qualification.",
    };

    await service.createQualifiedRunGroup({
      jiraKey: "CPDEV-302",
      ticketSummary: "Retrofit CPDEV-1234",
      sourceTaskManagementId: 78,
      customerId: 25,
      groupMode: "multi_branch_retrofit",
      groupMetadata: {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "master",
        repo: { repo_id: 1, repo_name: "core-app" },
        targetBranches: [
          { targetBranch: "medhok-monorepo-3.17", targetOrder: 1 },
          { targetBranch: "medhok-monorepo-3.18", targetOrder: 2 },
        ],
        skippedTargetBranches: ["medhok-monorepo-4.3"],
      },
      runs: [
        {
          repo,
          branchName: "medhok-monorepo-3.17",
          baseCommitSha: "abc123",
          qualification,
        },
        {
          repo,
          branchName: "medhok-monorepo-3.18",
          baseCommitSha: "def456",
          qualification: {
            ...qualification,
            branchName: "medhok-monorepo-3.18",
            baseCommitSha: "def456",
          },
        },
      ],
    });

    const groupInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO oneshot_run_groups"),
    );
    expect(groupInsert).toBeTruthy();
    const metadata = JSON.parse(String(groupInsert?.[1]?.[3]));
    expect(metadata).toMatchObject({
      mode: "multi_branch_retrofit",
      sourceJiraKey: "CPDEV-1234",
      sourceBranch: "master",
      repo: { repo_id: 1, repo_name: "core-app" },
      targetBranches: [
        { targetBranch: "medhok-monorepo-3.17", targetOrder: 1 },
        { targetBranch: "medhok-monorepo-3.18", targetOrder: 2 },
      ],
      skippedTargetBranches: ["medhok-monorepo-4.3"],
      repos: [
        {
          repo_id: 1,
          repo_name: "core-app",
          branch_name: "medhok-monorepo-3.17",
          base_commit_sha: "abc123",
        },
        {
          repo_id: 1,
          repo_name: "core-app",
          branch_name: "medhok-monorepo-3.18",
          base_commit_sha: "def456",
        },
      ],
    });

    const runInserts = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO oneshot_runs"),
    );
    expect(runInserts).toHaveLength(2);
    expect(runInserts.map(([, params]) => params?.[11])).toEqual([1, 1]);
    expect(runInserts.map(([, params]) => params?.[12])).toEqual([
      "medhok-monorepo-3.17",
      "medhok-monorepo-3.18",
    ]);
  });

  it("freezes workspace v2 mode on each grouped child run", async () => {
    process.env.ONESHOT_ARTIFACT_BUCKET = "specter-test-results";
    const insertIds = [900, 101, 0, 1001, 102, 0, 1002];
    const queryMock = vi
      .fn()
      .mockImplementation(async () => [
        { insertId: insertIds.shift() ?? 0, affectedRows: 1 },
      ]);
    const connection = {
      query: queryMock,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const publishStageMessage = vi.fn().mockResolvedValue(undefined);
    const s3Send = vi.fn().mockResolvedValue({});
    const pool = {
      getConnection: vi.fn().mockResolvedValue(connection),
      query: queryMock,
    };

    const service = new OneShotService(
      {
        getPool: () => pool,
      } as any,
      { publishStageMessage } as any,
      { send: s3Send } as any,
    );

    const qualification = {
      qualified: true,
      repoId: 1,
      branchName: "master",
      baseCommitSha: "abc123",
      requirementsSummary: ["Implement OCR status propagation"],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      repoInspectionPerformed: false,
      inspectedFiles: [],
      inspectionSummary: "Direct qualification.",
    };

    await service.createQualifiedRunGroup({
      jiraKey: "CPDEV-301",
      ticketSummary: "Implement OCR status propagation",
      sourceTaskManagementId: 77,
      customerId: 25,
      runs: [
        {
          repo: {
            id: 1,
            repo_name: "core-app",
            repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
            default_branch: "master",
          } as any,
          branchName: "master",
          baseCommitSha: "abc123",
          qualification,
        },
        {
          repo: {
            id: 8,
            repo_name: "Document-ai",
            repo_url: "https://github.com/mhk-repos/document-ai.git",
            default_branch: "main",
          } as any,
          branchName: "main",
          baseCommitSha: "def456",
          qualification: {
            ...qualification,
            repoId: 8,
            branchName: "main",
            baseCommitSha: "def456",
          },
        },
      ],
    });

    const runInserts = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO oneshot_runs"),
    );
    expect(runInserts).toHaveLength(2);
    expect(runInserts.map(([, params]) => params?.[8])).toEqual(["v2", "v2"]);
    expect(prepareImplementerWorkspaceMock).toHaveBeenCalledTimes(2);
    expect(prepareImplementerWorkspaceMock).toHaveBeenNthCalledWith(
      1,
      101,
      expect.objectContaining({ repo_name: "core-app" }),
      "abc123",
      "oneshot/cpdev-301-run-101",
    );
    expect(prepareImplementerWorkspaceMock).toHaveBeenNthCalledWith(
      2,
      102,
      expect.objectContaining({ repo_name: "Document-ai" }),
      "def456",
      "oneshot/cpdev-301-run-102",
    );
    expect(createRemoteBranchIfMissingMock).toHaveBeenCalledTimes(2);
  });
});

describe("OneShotService forceApproveRun", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a replan_required transition event with the escalation source stage on branch drift", async () => {
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM oneshot_runs WHERE id = ?")) {
        return [[buildRunRow()]];
      }
      return [{ affectedRows: 1 }];
    });

    const connection = {
      query: queryMock,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };

    const service = new OneShotService(
      {
        getPool: () => ({
          getConnection: vi.fn().mockResolvedValue(connection),
        }),
      } as any,
      { publishStageMessage: vi.fn() } as any,
      {} as any,
    );

    const result = await service.forceApproveRun(
      {
        id: 101,
        jira_key: "CPDEV-101",
        final_disposition: "code_review_escalated",
        current_test_version: null,
        current_implementation_version: 1,
      } as any,
      "new-base-sha",
    );

    expect(result).toEqual({ state: "replan_required" });

    const eventInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO oneshot_run_events"),
    );
    expect(eventInsert).toBeTruthy();
    expect(eventInsert?.[1]?.slice(0, 5)).toEqual([
      101,
      "state_transition",
      "escalated",
      "replan_required",
      "code_review",
    ]);
    expect(String(eventInsert?.[1]?.[5])).toContain('"reason":"branch_drift"');
    expect(String(eventInsert?.[1]?.[5])).toContain(
      '"escalationSource":"code_review"',
    );
  });
});
