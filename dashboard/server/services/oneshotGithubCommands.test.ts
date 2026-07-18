import { beforeEach, describe, expect, it, vi } from "vitest";
import { processOneShotGithubCommand, type OneShotGithubCommandStore } from "./oneshotGithubCommands.js";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "created",
    issue: {
      number: 2454,
      html_url: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2454",
      pull_request: {
        url: "https://api.github.com/repos/mhk-repos/cp-medhok-monorepo/pulls/2454",
      },
    },
    comment: {
      id: 99,
      html_url: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2454#issuecomment-99",
      body: "/oneshot fix the build",
      author_association: "MEMBER",
      user: {
        login: "rmadhukar",
        type: "User",
      },
    },
    repository: {
      full_name: "mhk-repos/cp-medhok-monorepo",
    },
    ...overrides,
  };
}

function pr(overrides: Record<string, unknown> = {}) {
  return {
    owner: "mhk-repos",
    repo: "cp-medhok-monorepo",
    pullNumber: 2454,
    state: "open",
    htmlUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2454",
    headRef: "oneshot/CPDEV-123",
    headSha: "abcdef1234567890",
    baseRef: "master",
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    jira_key: "CPDEV-123",
    state: "pr_open",
    current_plan_version: 1,
    current_pr_url: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2454",
    current_implementation_branch: "oneshot/CPDEV-123",
    current_implementation_commit_sha: "oldsha",
    current_implementation_version: 2,
    final_disposition: null,
    ...overrides,
  };
}

function buildStore(overrides: Partial<OneShotGithubCommandStore> = {}): OneShotGithubCommandStore {
  return {
    getCommandByDeliveryId: vi.fn().mockResolvedValue(null),
    rejectCommand: vi.fn().mockResolvedValue({
      id: 501,
      deliveryId: "delivery-1",
      status: "rejected",
    }),
    acceptOrCoalesceCommand: vi.fn().mockResolvedValue({
      command: {
        id: 501,
        deliveryId: "delivery-1",
        status: "accepted",
        requestedPlanVersion: 2,
      },
      run: run(),
      requestedPlanVersion: 2,
      candidateVersion: 3,
      queued: true,
      responseKind: "accepted",
    }),
    updateCommandResponse: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("processOneShotGithubCommand", () => {
  const fetchPullRequest = vi.fn();
  const fetchRepositoryPermissionForUser = vi.fn();
  const postIssueComment = vi.fn();
  const publishStageMessage = vi.fn();

  beforeEach(() => {
    fetchPullRequest.mockReset();
    fetchRepositoryPermissionForUser.mockReset();
    postIssueComment.mockReset();
    publishStageMessage.mockReset();
    fetchPullRequest.mockResolvedValue(pr());
    fetchRepositoryPermissionForUser.mockResolvedValue("write");
    postIssueComment.mockResolvedValue({
      id: "100",
      htmlUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2454#issuecomment-100",
      url: "https://api.github.com/repos/mhk-repos/cp-medhok-monorepo/issues/comments/100",
    });
    publishStageMessage.mockResolvedValue(undefined);
  });

  it("accepts /oneshot comments on pr_open runs and queues a planning revision", async () => {
    const store = buildStore();

    await expect(processOneShotGithubCommand({
      deliveryId: "delivery-1",
      event: "issue_comment",
      payload: payload(),
    }, {
      store,
      fetchPullRequest,
      fetchRepositoryPermissionForUser,
      postIssueComment,
      publisher: { publishStageMessage },
    })).resolves.toMatchObject({
      status: "accepted",
      oneshotRunId: 123,
      requestedPlanVersion: 2,
    });

    expect(store.acceptOrCoalesceCommand).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-1",
      commandText: "fix the build",
      requesterLogin: "rmadhukar",
      pullRequest: expect.objectContaining({
        headSha: "abcdef1234567890",
      }),
    }));
    expect(publishStageMessage).toHaveBeenCalledWith(
      123,
      "planning",
      2,
      "queued_for_planning",
      true,
      expect.objectContaining({
        dedupeToken: "github-command-delivery-1",
      }),
    );
    expect(postIssueComment).toHaveBeenCalledWith(expect.objectContaining({
      issueNumber: 2454,
      body: expect.stringContaining("queued"),
    }));
    expect(store.updateCommandResponse).toHaveBeenCalledWith(501, expect.objectContaining({
      responseCommentUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2454#issuecomment-100",
    }));
  });

  it("coalesces additional comments while the planning revision is still queued", async () => {
    const store = buildStore({
      acceptOrCoalesceCommand: vi.fn().mockResolvedValue({
        command: {
          id: 502,
          deliveryId: "delivery-2",
          status: "coalesced",
          requestedPlanVersion: 2,
        },
        run: run({ state: "queued_for_planning" }),
        requestedPlanVersion: 2,
        candidateVersion: 3,
        queued: false,
        responseKind: "coalesced",
      }),
    });

    await expect(processOneShotGithubCommand({
      deliveryId: "delivery-2",
      event: "issue_comment",
      payload: payload({ comment: { ...payload().comment, body: "/oneshot include the failed tests too" } }),
    }, {
      store,
      fetchPullRequest,
      fetchRepositoryPermissionForUser,
      postIssueComment,
      publisher: { publishStageMessage },
    })).resolves.toMatchObject({
      status: "coalesced",
      requestedPlanVersion: 2,
    });

    expect(publishStageMessage).not.toHaveBeenCalled();
    expect(postIssueComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining("added"),
    }));
  });

  it("rejects unauthorized commenters before queueing a replan", async () => {
    fetchRepositoryPermissionForUser.mockResolvedValue("read");
    const store = buildStore();

    await expect(processOneShotGithubCommand({
      deliveryId: "delivery-3",
      event: "issue_comment",
      payload: payload(),
    }, {
      store,
      fetchPullRequest,
      fetchRepositoryPermissionForUser,
      postIssueComment,
      publisher: { publishStageMessage },
    })).resolves.toMatchObject({
      status: "rejected",
      reason: "unauthorized",
    });

    expect(store.rejectCommand).toHaveBeenCalledWith(expect.objectContaining({
      status: "rejected",
      rejectionReason: "unauthorized",
    }));
    expect(publishStageMessage).not.toHaveBeenCalled();
    expect(postIssueComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining("write access"),
    }));
  });

  it("treats duplicate GitHub deliveries as idempotent", async () => {
    const store = buildStore({
      getCommandByDeliveryId: vi.fn().mockResolvedValue({
        id: 501,
        deliveryId: "delivery-1",
        status: "accepted",
        requestedPlanVersion: 2,
        responseCommentUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2454#issuecomment-100",
      }),
    });

    await expect(processOneShotGithubCommand({
      deliveryId: "delivery-1",
      event: "issue_comment",
      payload: payload(),
    }, {
      store,
      fetchPullRequest,
      fetchRepositoryPermissionForUser,
      postIssueComment,
      publisher: { publishStageMessage },
    })).resolves.toMatchObject({
      status: "duplicate",
      requestedPlanVersion: 2,
    });

    expect(fetchPullRequest).not.toHaveBeenCalled();
    expect(publishStageMessage).not.toHaveBeenCalled();
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it("recovers an accepted duplicate delivery that has not posted its acknowledgement", async () => {
    const store = buildStore({
      getCommandByDeliveryId: vi.fn().mockResolvedValue({
        id: 501,
        deliveryId: "delivery-1",
        oneshotRunId: 123,
        status: "accepted",
        requestedPlanVersion: 2,
        responseCommentUrl: null,
      }),
    });

    await expect(processOneShotGithubCommand({
      deliveryId: "delivery-1",
      event: "issue_comment",
      payload: payload(),
    }, {
      store,
      fetchPullRequest,
      fetchRepositoryPermissionForUser,
      postIssueComment,
      publisher: { publishStageMessage },
    })).resolves.toMatchObject({
      status: "duplicate",
      requestedPlanVersion: 2,
      responseCommentUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2454#issuecomment-100",
    });

    expect(fetchPullRequest).not.toHaveBeenCalled();
    expect(fetchRepositoryPermissionForUser).not.toHaveBeenCalled();
    expect(publishStageMessage).toHaveBeenCalledWith(
      123,
      "planning",
      2,
      "queued_for_planning",
      true,
      expect.objectContaining({
        dedupeToken: "github-command-delivery-1",
      }),
    );
    expect(postIssueComment).toHaveBeenCalledWith(expect.objectContaining({
      issueNumber: 2454,
      body: expect.stringContaining("queued"),
    }));
    expect(store.updateCommandResponse).toHaveBeenCalledWith(501, expect.objectContaining({
      responseCommentUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2454#issuecomment-100",
    }));
  });
});
