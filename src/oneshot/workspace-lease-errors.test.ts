import { describe, expect, it, vi } from "vitest";
import type { OneShotQueueMessage } from "./contracts.js";
import type { OneShotRun } from "./types.js";
import {
  isRepoCacheLeaseTimeoutError,
  isWorkspaceCheckoutTimeoutError,
  isWorkspaceLeaseLossError,
  RepoCacheLeaseTimeoutError,
  WorkspaceCheckoutTimeoutError,
  recoverStageAfterWorkspaceLeaseLoss,
  WorkspaceLeaseLostError,
} from "./workspace-lease-errors.js";

function buildPayload(
  overrides: Partial<OneShotQueueMessage> = {},
): OneShotQueueMessage {
  return {
    run_id: 42,
    stage: "planning",
    version: 1,
    expected_state: "queued_for_planning",
    revision: false,
    emitted_at: "2026-04-17T12:00:00.000Z",
    ...overrides,
  };
}

function buildRun(overrides: Partial<OneShotRun> = {}): OneShotRun {
  const now = new Date("2026-04-17T12:00:00.000Z");
  return {
    id: 42,
    run_group_id: null,
    workspace_mode: "v2",
    jira_key: "CPDEV-20686",
    source_task_management_id: 7,
    customer_id: 1,
    repo_id: 11,
    branch_name: "master",
    base_commit_sha: "0123456789abcdef0123456789abcdef01234567",
    run_branch_name: "oneshot/cpdev-20686-run-42",
    run_branch_base_sha: "0123456789abcdef0123456789abcdef01234567",
    run_branch_created_at: now,
    state: "queued_for_planning",
    max_review_loops: 3,
    review_loop_count: 0,
    current_plan_version: null,
    current_review_version: null,
    current_implementation_version: null,
    current_implementation_branch: null,
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

function buildDeps(options: {
  requeueResult: boolean;
  latestRun?: OneShotRun | null;
}) {
  return {
    oneShotDb: {
      runs: {
        updateRunStateIfCurrentState: vi
          .fn()
          .mockResolvedValue(options.requeueResult),
        getRunById: vi.fn().mockResolvedValue(options.latestRun ?? null),
      },
      events: {
        createEvent: vi.fn().mockResolvedValue(undefined),
      },
    },
    logger: {
      warn: vi.fn(),
    },
  };
}

describe("recoverStageAfterWorkspaceLeaseLoss", () => {
  it("recognizes typed workspace lease-loss errors", () => {
    expect(
      isWorkspaceLeaseLossError(new WorkspaceLeaseLostError("lease gone")),
    ).toBe(true);
  });

  it("recognizes repo-cache lease timeouts as retryable lease errors", () => {
    const error = new RepoCacheLeaseTimeoutError("repo-cache:core-app");

    expect(isRepoCacheLeaseTimeoutError(error)).toBe(true);
    expect(isWorkspaceLeaseLossError(error)).toBe(true);
  });

  it("routes repo-cache lease timeouts through lease-loss recovery", async () => {
    const { oneShotDb, logger } = buildDeps({ requeueResult: true });
    const result = await recoverStageAfterWorkspaceLeaseLoss({
      oneShotDb: oneShotDb as never,
      logger: logger as never,
      runId: 42,
      jiraKey: "CPDEV-20686",
      payload: buildPayload(),
      receiveCount: 2,
      error: new RepoCacheLeaseTimeoutError("repo-cache:core-app"),
    });

    expect(result).toBe(false);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "planning",
      "queued_for_planning",
      {
        last_error:
          "Workspace lease lost during planning; stage requeued for retry",
      },
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "planning",
        to_state: "queued_for_planning",
        stage: "planning",
        metadata_json: expect.objectContaining({
          reason: "workspace_lease_lost",
          error: expect.stringContaining("repo-cache:core-app"),
          version: 1,
          revision: false,
          receiveCount: 2,
        }),
      }),
    );
  });

  it("applies optional recovery updates and metadata when requeueing", async () => {
    const { oneShotDb, logger } = buildDeps({ requeueResult: true });
    const result = await recoverStageAfterWorkspaceLeaseLoss({
      oneShotDb: oneShotDb as never,
      logger: logger as never,
      runId: 42,
      jiraKey: "CPDEV-20686",
      payload: buildPayload(),
      receiveCount: 1,
      error: new Error("Lost OneShot workspace lease"),
      updates: { planning_attempt_count: 2 },
      metadata: {
        planningAttemptCountReset: true,
        previousPlanningAttemptCount: 2,
      },
    });

    expect(result).toBe(false);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "planning",
      "queued_for_planning",
      {
        last_error:
          "Workspace lease lost during planning; stage requeued for retry",
        planning_attempt_count: 2,
      },
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          reason: "workspace_lease_lost",
          planningAttemptCountReset: true,
          previousPlanningAttemptCount: 2,
        }),
      }),
    );
  });

  it("recognizes workspace checkout timeouts without treating them as lease loss", () => {
    const error = new WorkspaceCheckoutTimeoutError(
      "workspace_checkout_timeout: git worktree add failed or timed out",
    );

    expect(isWorkspaceCheckoutTimeoutError(error)).toBe(true);
    expect(isWorkspaceCheckoutTimeoutError(error.message)).toBe(true);
    expect(isWorkspaceLeaseLossError(error)).toBe(false);
  });

  it("requeues the active stage and leaves the message for redelivery", async () => {
    const { oneShotDb, logger } = buildDeps({ requeueResult: true });
    const result = await recoverStageAfterWorkspaceLeaseLoss({
      oneShotDb: oneShotDb as never,
      logger: logger as never,
      runId: 42,
      jiraKey: "CPDEV-20686",
      payload: buildPayload(),
      receiveCount: 1,
      error: new Error("Lost OneShot workspace lease"),
    });

    expect(result).toBe(false);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "planning",
      "queued_for_planning",
      {
        last_error:
          "Workspace lease lost during planning; stage requeued for retry",
      },
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "planning",
        to_state: "queued_for_planning",
        stage: "planning",
        metadata_json: expect.objectContaining({
          reason: "workspace_lease_lost",
          version: 1,
          revision: false,
          receiveCount: 1,
        }),
      }),
    );
  });

  it("leaves the message for redelivery when the run is already requeued at the same version", async () => {
    const { oneShotDb, logger } = buildDeps({
      requeueResult: false,
      latestRun: buildRun(),
    });

    await expect(
      recoverStageAfterWorkspaceLeaseLoss({
        oneShotDb: oneShotDb as never,
        logger: logger as never,
        runId: 42,
        jiraKey: "CPDEV-20686",
        payload: buildPayload(),
        receiveCount: 2,
        error: new Error("Lost OneShot workspace lease"),
      }),
    ).resolves.toBe(false);
  });

  it("acknowledges stale worker messages when another owner has moved the run", async () => {
    const { oneShotDb, logger } = buildDeps({
      requeueResult: false,
      latestRun: buildRun({
        state: "queued_for_review",
        current_plan_version: 1,
      }),
    });

    await expect(
      recoverStageAfterWorkspaceLeaseLoss({
        oneShotDb: oneShotDb as never,
        logger: logger as never,
        runId: 42,
        jiraKey: "CPDEV-20686",
        payload: buildPayload(),
        receiveCount: 2,
        error: new Error("Lost OneShot workspace lease"),
      }),
    ).resolves.toBe(true);
  });
});
