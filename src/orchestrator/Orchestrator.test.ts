import { beforeEach, describe, expect, it, vi } from "vitest";

const updateTaskManagementStatusMock = vi.fn();
const upsertOneShotArtifactRunMock = vi.fn();
const getAgentByNameMock = vi.fn();
const s3SendMock = vi.fn();
const jiraClientMock = {
  searchIssues: vi.fn(),
  updateIssueLabels: vi.fn(),
  fetchIssue: vi.fn(),
  addComment: vi.fn(),
};
const runDocumentationArtifactForIssueMock = vi.fn();
const runTriageMock = vi.fn();

vi.mock("./database.js", () => ({
  getDatabase: vi.fn(() => ({
    updateTaskManagementStatus: updateTaskManagementStatusMock,
    upsertOneShotArtifactRun: upsertOneShotArtifactRunMock,
    getAgentByName: getAgentByNameMock,
  })),
}));

vi.mock("./JiraClient.js", () => ({
  getJiraClient: vi.fn(() => jiraClientMock),
  createJiraClient: vi.fn(() => jiraClientMock),
}));

vi.mock("../oneshot/documentation/generate.js", () => ({
  runDocumentationArtifactForIssue: runDocumentationArtifactForIssueMock,
}));

vi.mock("./triage/index.js", () => ({
  runTriage: runTriageMock,
}));

vi.mock("./storage.js", () => ({
  getStorage: vi.fn(() => ({})),
}));

vi.mock("../utils/awsClients.js", () => ({
  createS3Client: vi.fn(() => ({
    send: s3SendMock,
  })),
}));

beforeEach(() => {
  jiraClientMock.searchIssues.mockReset();
  jiraClientMock.updateIssueLabels.mockReset();
  jiraClientMock.updateIssueLabels.mockResolvedValue(undefined);
  jiraClientMock.fetchIssue.mockReset();
  jiraClientMock.fetchIssue.mockResolvedValue({ fields: { labels: [] } });
  jiraClientMock.addComment.mockReset();
  jiraClientMock.addComment.mockResolvedValue({ id: "comment-1" });
  runDocumentationArtifactForIssueMock.mockReset();
  runTriageMock.mockReset();
  upsertOneShotArtifactRunMock.mockReset();
  upsertOneShotArtifactRunMock.mockResolvedValue(undefined);
  getAgentByNameMock.mockReset();
  getAgentByNameMock.mockResolvedValue(null);
  delete process.env.DOCUMENTATION_LABEL_POLL_ENABLED;
  delete process.env.DOCUMENTATION_LABEL_POLL_LIMIT;
});

function jiraResponse(status = 204, payload: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 204 ? "No Content" : "OK",
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

async function buildOrchestrator() {
  const { Orchestrator } = await import("./Orchestrator.js");
  return new Orchestrator({
    jiraBaseUrl: "https://jira.example",
    jiraUsername: "agent@example.com",
    jiraToken: "global-token",
    autoReassignTickets: false,
  }) as any;
}

function buildTask(agentName: string) {
  return {
    id: 123,
    jira_number: "CPDEV-123",
    agent_name: agentName,
    result_s3_bucket: "results",
    result_s3_key: `${agentName.toLowerCase()}/result.md`,
    jira_token: "agent-token",
  };
}

function expectResultComment(callIndex: number, text: string) {
  expect(global.fetch).toHaveBeenNthCalledWith(
    callIndex,
    "https://jira.example/rest/api/3/issue/CPDEV-123/comment",
    expect.objectContaining({
      method: "POST",
    }),
  );
  const request = (global.fetch as any).mock.calls[callIndex - 1][1];
  expect(request.body).toContain(text);
  expect(request.body).toContain("AI-GENERATED CONTENT");
}

describe("Orchestrator DARCI/HERMES Jira note posting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    updateTaskManagementStatusMock.mockReset();
    s3SendMock.mockReset();
    s3SendMock.mockResolvedValue({
      Body: {
        transformToString: vi
          .fn()
          .mockResolvedValue("Root cause is in src/Foo.java:42"),
      },
    });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jiraResponse(201, { id: "comment-1" }))
      .mockResolvedValueOnce(jiraResponse());
  });

  it("posts DARCI findings as a full Jira comment", async () => {
    const orchestrator = await buildOrchestrator();

    await orchestrator.postResultToJira(buildTask("DARCI"));

    expectResultComment(1, "Root cause is in src/Foo.java:42");
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://jira.example/rest/api/3/issue/CPDEV-123",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          update: {
            labels: [{ add: "DARCI_DONE" }],
          },
        }),
      }),
    );
    expect(updateTaskManagementStatusMock).toHaveBeenCalledWith(
      123,
      "posted_to_jira",
      expect.objectContaining({ jira_posted_at: expect.any(Date) }),
    );
  });

  it("posts HERMES findings as a full Jira comment", async () => {
    s3SendMock.mockResolvedValueOnce({
      Body: {
        transformToString: vi.fn().mockResolvedValue("Config lives in app.yml"),
      },
    });
    const orchestrator = await buildOrchestrator();

    await orchestrator.postResultToJira(buildTask("HERMES"));

    expectResultComment(1, "Config lives in app.yml");
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://jira.example/rest/api/3/issue/CPDEV-123",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          update: {
            labels: [{ add: "HERMES_DONE" }],
          },
        }),
      }),
    );
  });

  it("still finalizes Jira posting when done-label addition fails", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jiraResponse(201, { id: "comment-1" }))
      .mockResolvedValueOnce(
        jiraResponse(500, { errorMessages: ["bad label"] }),
      );
    const orchestrator = await buildOrchestrator();

    await orchestrator.postResultToJira(buildTask("DARCI"));

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(updateTaskManagementStatusMock).toHaveBeenCalledWith(
      123,
      "posted_to_jira",
      expect.objectContaining({ jira_posted_at: expect.any(Date) }),
    );
  });
});

describe("Orchestrator OneShot notification posting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi
      .fn()
      .mockResolvedValue(jiraResponse(201, { id: "comment-1" }));
  });

  it("posts verification-only completion notifications to Jira", async () => {
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 77,
          oneshot_run_id: 42,
          jira_key: "CPDEV-23568",
          notification_type: "verification_only_completed",
          body_markdown: "OneShot completed without opening a PR.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-02T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://jira.example/rest/api/3/issue/CPDEV-23568/comment",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(77);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("posts OneShot notifications with the DB-backed QUALIFIER Jira credentials", async () => {
    getAgentByNameMock.mockResolvedValue({
      id: 11,
      name: "QUALIFIER",
      jira_username: "devai@mhk.com",
      jira_token: "db-backed-token",
    });
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 79,
          oneshot_run_id: 44,
          jira_key: "CPDEV-23570",
          notification_type: "verification_only_completed",
          body_markdown: "OneShot completed without opening a PR.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-02T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications } };

    await orchestrator.checkAndPostOneShotNotifications();

    const expectedAuth = `Basic ${Buffer.from(
      "devai@mhk.com:db-backed-token",
    ).toString("base64")}`;
    expect(global.fetch).toHaveBeenCalledWith(
      "https://jira.example/rest/api/3/issue/CPDEV-23570/comment",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: expectedAuth,
        }),
      }),
    );
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(79);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("continues to drain legacy completed notifications without posting", async () => {
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 78,
          oneshot_run_id: 43,
          jira_key: "CPDEV-23569",
          notification_type: "completed",
          body_markdown: "Legacy completed notification.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-02T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(78);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("PFOS-DONE: pr_ready notification applies PFOS-DONE and removes stale outcome labels", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS", "PFOS-FAILED"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: "https://github.com/org/repo/pull/1",
        state: "pr_ready",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 80,
          oneshot_run_id: 50,
          jira_key: "CPDEV-23600",
          notification_type: "pr_ready",
          body_markdown: "PR is ready for review.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).toHaveBeenCalledWith(
      "CPDEV-23600",
      expect.objectContaining({
        add: ["PFOS-DONE"],
        remove: expect.arrayContaining([
          "PFOS-FAILED",
          "PFOS-BLOCKED",
          "PFOS-NOT-QUALIFIED",
        ]),
      }),
    );
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(80);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("PFOS run_failed notification applies PFOS-FAILED and removes stale outcome labels", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS", "PFOS-DONE"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: null,
        state: "failed",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 81,
          oneshot_run_id: 51,
          jira_key: "CPDEV-23601",
          notification_type: "run_failed",
          body_markdown: "Run failed.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).toHaveBeenCalledWith(
      "CPDEV-23601",
      expect.objectContaining({
        add: ["PFOS-FAILED"],
        remove: expect.arrayContaining([
          "PFOS-DONE",
          "PFOS-BLOCKED",
          "PFOS-NOT-QUALIFIED",
        ]),
      }),
    );
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(81);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("PFOS review_blocked notification applies PFOS-BLOCKED and removes stale outcome labels", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: null,
        state: "blocked",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 82,
          oneshot_run_id: 52,
          jira_key: "CPDEV-23602",
          notification_type: "review_blocked",
          body_markdown: "Review is blocked.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).toHaveBeenCalledWith(
      "CPDEV-23602",
      expect.objectContaining({
        add: ["PFOS-BLOCKED"],
        remove: expect.arrayContaining([
          "PFOS-DONE",
          "PFOS-FAILED",
          "PFOS-NOT-QUALIFIED",
        ]),
      }),
    );
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(82);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("PFOS progress_update notification applies PFOS-BLOCKED when the run is blocked without a PR", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS", "PFOS-DONE"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: null,
        state: "blocked",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 88,
          oneshot_run_id: 58,
          jira_key: "CPDEV-23608",
          notification_type: "progress_update",
          body_markdown: "No pull request was created.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).toHaveBeenCalledWith(
      "CPDEV-23608",
      expect.objectContaining({
        add: ["PFOS-BLOCKED"],
        remove: expect.arrayContaining([
          "PFOS-DONE",
          "PFOS-FAILED",
          "PFOS-NOT-QUALIFIED",
        ]),
      }),
    );
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(88);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("PFOS branch_drift notification applies PFOS-BLOCKED when the run requires replan without a PR", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: null,
        state: "replan_required",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 89,
          oneshot_run_id: 59,
          jira_key: "CPDEV-23609",
          notification_type: "branch_drift",
          body_markdown: "Branch drift requires replan.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).toHaveBeenCalledWith(
      "CPDEV-23609",
      expect.objectContaining({ add: ["PFOS-BLOCKED"] }),
    );
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(89);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("PFOS code_review_blocked notification applies PFOS-DONE when a WIP PR exists", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS", "PFOS-BLOCKED"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: "https://github.com/org/repo/pull/6",
        state: "pr_open",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 90,
          oneshot_run_id: 60,
          jira_key: "CPDEV-23610",
          notification_type: "code_review_blocked",
          body_markdown: "Code review blocked but a WIP PR exists.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).toHaveBeenCalledWith(
      "CPDEV-23610",
      expect.objectContaining({
        add: ["PFOS-DONE"],
        remove: expect.arrayContaining([
          "PFOS-BLOCKED",
          "PFOS-FAILED",
          "PFOS-NOT-QUALIFIED",
        ]),
      }),
    );
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(90);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("PFOS code_review_escalated notification applies PFOS-DONE when a WIP PR exists", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS", "PFOS-BLOCKED"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: "https://github.com/org/repo/pull/7",
        state: "pr_open",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 91,
          oneshot_run_id: 61,
          jira_key: "CPDEV-23611",
          notification_type: "code_review_escalated",
          body_markdown: "Code review escalated but a WIP PR exists.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).toHaveBeenCalledWith(
      "CPDEV-23611",
      expect.objectContaining({
        add: ["PFOS-DONE"],
        remove: expect.arrayContaining([
          "PFOS-BLOCKED",
          "PFOS-FAILED",
          "PFOS-NOT-QUALIFIED",
        ]),
      }),
    );
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(91);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("PFOS progress_update notification does not apply an outcome label while the run is active", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: null,
        state: "planning",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 92,
          oneshot_run_id: 62,
          jira_key: "CPDEV-23612",
          notification_type: "progress_update",
          body_markdown: "TRACE evidence posted.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).not.toHaveBeenCalled();
    expect(jiraClientMock.fetchIssue).not.toHaveBeenCalled();
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(92);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("non-PFOS notification does not apply PFOS outcome labels", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: [] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: "https://github.com/org/repo/pull/2",
        state: "pr_ready",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 83,
          oneshot_run_id: 53,
          jira_key: "CPDEV-23603",
          notification_type: "pr_ready",
          body_markdown: "PR is ready.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).not.toHaveBeenCalled();
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(83);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("skips outcome label when PFOS label was removed from the ticket", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["SOME-OTHER-LABEL"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: "https://github.com/org/repo/pull/3",
        state: "pr_ready",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 84,
          oneshot_run_id: 54,
          jira_key: "CPDEV-23604",
          notification_type: "pr_ready",
          body_markdown: "PR is ready.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).not.toHaveBeenCalled();
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(84);
    expect(notifications.releaseNotificationClaim).not.toHaveBeenCalled();
  });

  it("releases notification claim for retry when updateIssueLabels throws", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS"] },
    });
    jiraClientMock.updateIssueLabels.mockRejectedValueOnce(
      new Error("Jira API error"),
    );
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: "https://github.com/org/repo/pull/4",
        state: "pr_ready",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 85,
          oneshot_run_id: 55,
          jira_key: "CPDEV-23605",
          notification_type: "pr_ready",
          body_markdown: "PR is ready.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(notifications.markNotificationPosted).not.toHaveBeenCalled();
    expect(notifications.releaseNotificationClaim).toHaveBeenCalledWith(85);
  });

  it("PFOS pr_created with current_pr_url applies PFOS-DONE", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: "https://github.com/org/repo/pull/5",
        state: "pr_created",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 86,
          oneshot_run_id: 56,
          jira_key: "CPDEV-23606",
          notification_type: "pr_created",
          body_markdown: "PR created.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).toHaveBeenCalledWith(
      "CPDEV-23606",
      expect.objectContaining({ add: ["PFOS-DONE"] }),
    );
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(86);
  });

  it("PFOS pr_created without current_pr_url does not apply PFOS-DONE", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: null,
        state: "pr_created",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 87,
          oneshot_run_id: 57,
          jira_key: "CPDEV-23607",
          notification_type: "pr_created",
          body_markdown: "PR created.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).not.toHaveBeenCalled();
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(87);
  });

  it("PFOS pr_ready without current_pr_url does not apply PFOS-DONE", async () => {
    jiraClientMock.fetchIssue.mockResolvedValue({
      fields: { labels: ["PFOS"] },
    });
    const runs = {
      getRunById: vi.fn().mockResolvedValue({
        current_pr_url: null,
        state: "testing",
      }),
    };
    const notifications = {
      getPendingNotifications: vi.fn().mockResolvedValue([
        {
          id: 93,
          oneshot_run_id: 63,
          jira_key: "CPDEV-23613",
          notification_type: "pr_ready",
          body_markdown: "PR ready notification without persisted PR URL.",
          status: "pending",
          error: null,
          created_at: new Date("2026-06-09T12:00:00.000Z"),
          posted_at: null,
        },
      ]),
      claimNotificationForPosting: vi.fn().mockResolvedValue(true),
      markNotificationPosted: vi.fn().mockResolvedValue(undefined),
      releaseNotificationClaim: vi.fn().mockResolvedValue(undefined),
    };
    const orchestrator = await buildOrchestrator();
    orchestrator.oneShotService = { database: { notifications, runs } };

    await orchestrator.checkAndPostOneShotNotifications();

    expect(jiraClientMock.updateIssueLabels).not.toHaveBeenCalled();
    expect(jiraClientMock.fetchIssue).not.toHaveBeenCalled();
    expect(notifications.markNotificationPosted).toHaveBeenCalledWith(93);
  });
});

describe("Orchestrator duplicate assignment handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function buildAgent(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 1,
      name: "DARCI",
      task_type: "darci",
      jira_token: "agent-token",
      ...overrides,
    };
  }

  function buildIssue(key = "CPDEV-22680") {
    return {
      key,
      fields: {
        summary: "Discharge Date error",
        labels: ["DARCI"],
      },
    };
  }

  it("reopens exhausted completed rows for Jira-post retry instead of rerunning the agent", async () => {
    const orchestrator = await buildOrchestrator();
    const existing = {
      id: 2533,
      jira_number: "CPDEV-22680",
      agent_id: 1,
      status: "completed",
      retry_count: 3,
    };
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(existing),
      resetTaskManagementJiraPostRetry: vi.fn().mockResolvedValue(undefined),
    };
    const issueAssignmentService = {
      assignIssueToAgent: vi.fn(),
    };
    orchestrator.db = db;
    orchestrator.issueAssignmentService = issueAssignmentService;

    await orchestrator.assignIssueToAgent(buildIssue(), buildAgent());

    expect(db.resetTaskManagementJiraPostRetry).toHaveBeenCalledWith(2533);
    expect(issueAssignmentService.assignIssueToAgent).not.toHaveBeenCalled();
  });

  it("leaves completed rows below the Jira-post retry limit on the existing post path", async () => {
    const orchestrator = await buildOrchestrator();
    const existing = {
      id: 2533,
      jira_number: "CPDEV-22680",
      agent_id: 1,
      status: "completed",
      retry_count: 1,
    };
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(existing),
      resetTaskManagementJiraPostRetry: vi.fn(),
    };
    const issueAssignmentService = {
      assignIssueToAgent: vi.fn(),
    };
    orchestrator.db = db;
    orchestrator.issueAssignmentService = issueAssignmentService;

    await orchestrator.assignIssueToAgent(buildIssue(), buildAgent());

    expect(db.resetTaskManagementJiraPostRetry).not.toHaveBeenCalled();
    expect(issueAssignmentService.assignIssueToAgent).not.toHaveBeenCalled();
  });

  it("passes failed rows below the attempt cap to assignment service so the existing row can be requeued", async () => {
    const orchestrator = await buildOrchestrator();
    const existing = {
      id: 2534,
      jira_number: "CPDEV-22681",
      agent_id: 1,
      status: "failed",
      retry_count: 2,
    };
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(existing),
      resetTaskManagementJiraPostRetry: vi.fn(),
    };
    const issueAssignmentService = {
      assignIssueToAgent: vi.fn().mockResolvedValue({
        taskManagementId: 2534,
        disposition: "requeued",
      }),
    };
    orchestrator.db = db;
    orchestrator.issueAssignmentService = issueAssignmentService;

    await orchestrator.assignIssueToAgent(
      buildIssue("CPDEV-22681"),
      buildAgent(),
    );

    expect(db.resetTaskManagementJiraPostRetry).not.toHaveBeenCalled();
    expect(issueAssignmentService.assignIssueToAgent).toHaveBeenCalledWith(
      buildIssue("CPDEV-22681"),
      buildAgent(),
      expect.objectContaining({
        existingTaskManagement: existing,
      }),
    );
  });

  it("skips failed rows that reached the processing attempt cap", async () => {
    const orchestrator = await buildOrchestrator();
    const existing = {
      id: 2535,
      jira_number: "MPSUP-4947",
      agent_id: 10,
      status: "failed",
      retry_count: 3,
    };
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(existing),
      resetTaskManagementJiraPostRetry: vi.fn(),
    };
    const issueAssignmentService = {
      assignIssueToAgent: vi.fn(),
    };
    orchestrator.db = db;
    orchestrator.issueAssignmentService = issueAssignmentService;

    await orchestrator.assignIssueToAgent(
      buildIssue("MPSUP-4947"),
      buildAgent({ id: 10, name: "SRLOG", task_type: "log_analysis" }),
    );

    expect(db.resetTaskManagementJiraPostRetry).not.toHaveBeenCalled();
    expect(issueAssignmentService.assignIssueToAgent).not.toHaveBeenCalled();
  });
});

describe("Orchestrator documentation artifact label polling", () => {
  const documentationSuccessKey = "DOCS-1001";
  const documentationFailureKey = "DOCS-1002";

  function mockEmptyScanSearches() {
    // Scan searches before docs polling: WIZ (approved + pending = 2), WIZ-CODE
    // (auto-apply, pending only = 1), SONAR (approved + pending = 2) = 5 empty
    // responses.
    jiraClientMock.searchIssues
      .mockResolvedValueOnce({ total: 0, issues: [] })
      .mockResolvedValueOnce({ total: 0, issues: [] })
      .mockResolvedValueOnce({ total: 0, issues: [] })
      .mockResolvedValueOnce({ total: 0, issues: [] })
      .mockResolvedValueOnce({ total: 0, issues: [] });
  }

  it("picks up DOCS-GENERATE tickets and runs the documentation artifact flow", async () => {
    mockEmptyScanSearches();
    jiraClientMock.searchIssues.mockResolvedValueOnce({
      total: 1,
      issues: [{ key: documentationSuccessKey }],
    });
    runDocumentationArtifactForIssueMock.mockResolvedValue({
      documentTypeLabel: "DOC-TYPE-TROUBLESHOOTING",
      attachmentResult: {
        filenames: [`${documentationSuccessKey}-troubleshooting.md`],
      },
    });
    const orchestrator = await buildOrchestrator();

    await orchestrator.pollForTriageLabels();

    // 5 scan-source searches precede the documentation-label search: WIZ
    // (approved+pending), WIZ-CODE (auto-apply, pending only), SONAR
    // (approved+pending). So the docs JQL is the 6th call (index 5).
    const docsJql = jiraClientMock.searchIssues.mock.calls[5][0] as string;
    expect(docsJql).toContain('labels = "DOCS-GENERATE"');
    expect(docsJql).toContain('"DOC-TYPE-TROUBLESHOOTING"');
    expect(docsJql).toContain('"DOCS-GENERATED"');
    expect(docsJql).toContain('"DOCS-IN-PROGRESS"');
    // DOCS-REPLAN re-opens a terminal (review-required) ticket for regeneration.
    expect(docsJql).toContain('"DOCS-REPLAN"');
    expect(jiraClientMock.updateIssueLabels).toHaveBeenCalledWith(
      documentationSuccessKey,
      {
        add: ["DOCS-IN-PROGRESS"],
        remove: [
          "DOCS-REPLAN",
          "DOCS-BLOCKED",
          "DOCS-FAILED",
          "DOCS-GENERATED",
          "DOCS-NOT-QUALIFIED",
        ],
      },
    );
    expect(runDocumentationArtifactForIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        issueKey: documentationSuccessKey,
        attachToJira: true,
        addJiraComment: true,
        jiraConfig: {
          baseUrl: "https://jira.example",
          username: "agent@example.com",
          token: "global-token",
        },
      }),
    );
  });

  it("marks documentation tickets failed when automatic artifact generation fails", async () => {
    mockEmptyScanSearches();
    jiraClientMock.searchIssues.mockResolvedValueOnce({
      total: 1,
      issues: [{ key: documentationFailureKey }],
    });
    runDocumentationArtifactForIssueMock.mockRejectedValue(
      new Error("Missing required documentation label"),
    );
    const orchestrator = await buildOrchestrator();

    await orchestrator.pollForTriageLabels();

    expect(jiraClientMock.updateIssueLabels).toHaveBeenNthCalledWith(
      1,
      documentationFailureKey,
      {
        add: ["DOCS-IN-PROGRESS"],
        remove: [
          "DOCS-REPLAN",
          "DOCS-BLOCKED",
          "DOCS-FAILED",
          "DOCS-GENERATED",
          "DOCS-NOT-QUALIFIED",
        ],
      },
    );
    expect(jiraClientMock.updateIssueLabels).toHaveBeenNthCalledWith(
      2,
      documentationFailureKey,
      {
        add: ["DOCS-FAILED"],
        remove: ["DOCS-IN-PROGRESS"],
      },
    );
    expect(jiraClientMock.addComment).toHaveBeenCalledWith(
      documentationFailureKey,
      expect.stringContaining("Missing required documentation label"),
    );
    expect(upsertOneShotArtifactRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: documentationFailureKey,
        mode: "documentation",
        status: "failed",
        reviewItems: ["Missing required documentation label"],
      }),
    );
  });

  it("re-selects a DOCS-REPLAN ticket and never excludes it via a completion-terminal label", async () => {
    mockEmptyScanSearches();
    jiraClientMock.searchIssues.mockResolvedValueOnce({
      total: 1,
      issues: [{ key: documentationSuccessKey }],
    });
    runDocumentationArtifactForIssueMock.mockResolvedValue({
      documentTypeLabel: "DOC-TYPE-TROUBLESHOOTING",
      attachmentResult: {
        filenames: [`${documentationSuccessKey}-troubleshooting.md`],
      },
    });
    const orchestrator = await buildOrchestrator();

    await orchestrator.pollForTriageLabels();

    const docsJql = jiraClientMock.searchIssues.mock.calls[5][0] as string;
    // DOCS-IN-PROGRESS is a hard exclusion so an in-flight run is never
    // double-processed; the completion-terminal labels only exclude a ticket
    // when DOCS-REPLAN is absent.
    expect(docsJql).toContain('labels not in ("DOCS-IN-PROGRESS")');
    expect(docsJql).toContain('labels = "DOCS-REPLAN"');
    expect(docsJql).toMatch(
      /OR labels not in \("DOCS-GENERATED", "DOCS-NOT-QUALIFIED", "DOCS-BLOCKED", "DOCS-FAILED"\)/,
    );
    // The pickup transition clears the DOCS-REPLAN trigger and any prior
    // terminal label so regeneration reaches an unambiguous terminal state.
    expect(jiraClientMock.updateIssueLabels).toHaveBeenCalledWith(
      documentationSuccessKey,
      {
        add: ["DOCS-IN-PROGRESS"],
        remove: [
          "DOCS-REPLAN",
          "DOCS-BLOCKED",
          "DOCS-FAILED",
          "DOCS-GENERATED",
          "DOCS-NOT-QUALIFIED",
        ],
      },
    );
  });
});

describe("Orchestrator Wiz Code auto-apply (no approval gate)", () => {
  it("applies a WIZ-CODE-SCAN-PENDING epic directly without SCAN-APPROVED", async () => {
    // Search order: WIZ approved, WIZ pending, WIZ-CODE pending (auto-apply),
    // SONAR approved, SONAR pending, then docs.
    jiraClientMock.searchIssues
      .mockResolvedValueOnce({ total: 0, issues: [] }) // WIZ approved
      .mockResolvedValueOnce({ total: 0, issues: [] }) // WIZ pending
      .mockResolvedValueOnce({
        total: 1,
        issues: [{ key: "CPDEV-26139" }],
      }) // WIZ-CODE pending → auto-apply
      .mockResolvedValueOnce({ total: 0, issues: [] }) // SONAR approved
      .mockResolvedValueOnce({ total: 0, issues: [] }) // SONAR pending
      .mockResolvedValueOnce({ total: 0, issues: [] }); // docs
    runTriageMock.mockResolvedValue({ mode: "apply", source: "wiz-code" });

    const orchestrator = await buildOrchestrator();
    await orchestrator.pollForTriageLabels();

    // WIZ-CODE pending epic is applied directly (not analyzed / not gated).
    expect(runTriageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        epicKey: "CPDEV-26139",
        mode: "apply",
        sourceOverride: "wiz-code",
      }),
    );
    // The WIZ-CODE pending JQL must NOT require SCAN-APPROVED, and must exclude
    // terminal states so finished epics are not re-applied.
    const wizCodePendingJql = jiraClientMock.searchIssues.mock
      .calls[2][0] as string;
    expect(wizCodePendingJql).toContain('"WIZ-CODE-SCAN-PENDING"');
    expect(wizCodePendingJql).not.toContain("WIZ-CODE-SCAN-APPROVED");
    expect(wizCodePendingJql).toContain("WIZ-CODE-SCAN-IN-PROGRESS");

    // Analyze mode is never used for WIZ-CODE (no REVIEW-READY handoff).
    for (const call of runTriageMock.mock.calls) {
      if (call[2]?.sourceOverride === "wiz-code") {
        expect(call[2].mode).toBe("apply");
      }
    }
  });
});
