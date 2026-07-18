import { describe, expect, it, vi } from "vitest";
import { OneShotDashboardRunRequestProcessor } from "./OneShotDashboardRunRequestProcessor.js";

describe("OneShotDashboardRunRequestProcessor", () => {
  it("adds PFOS and marks the request task_created when the Jira issue is fresh", async () => {
    const request = {
      id: 11,
      jira_key: "CPDEV-11",
    };
    const qualifierAgent = {
      id: 5,
      name: "QUALIFIER",
      is_active: true,
      jira_token: "qual-token",
    };
    const issue = {
      key: "CPDEV-11",
      fields: {
        labels: [],
      },
    };

    const queryMock = vi.fn().mockResolvedValue([[]]);
    const db = {
      claimNextOneShotDashboardRunRequest: vi
        .fn()
        .mockResolvedValueOnce(request)
        .mockResolvedValueOnce(null),
      getAgentByName: vi.fn().mockResolvedValue(qualifierAgent),
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      markOneShotDashboardRunRequestTaskCreated: vi.fn().mockResolvedValue(undefined),
      markOneShotDashboardRunRequestFailed: vi.fn().mockResolvedValue(undefined),
      getPool: vi.fn().mockReturnValue({ query: queryMock }),
    };
    const oneShotService = {
      getLatestRunByJiraKey: vi.fn().mockResolvedValue(null),
    };
    const issueAssignmentService = {
      fetchJiraIssue: vi.fn().mockResolvedValue(issue),
      addLabel: vi.fn().mockResolvedValue(undefined),
      assignIssueToAgent: vi.fn().mockResolvedValue({
        taskManagementId: 321,
        disposition: "created",
      }),
      extractCustomerFromJira: vi.fn().mockReturnValue(null),
    };

    const processor = new OneShotDashboardRunRequestProcessor(
      db as never,
      oneShotService as never,
      issueAssignmentService as never,
    );

    await expect(processor.processQueuedRequests()).resolves.toEqual({
      processed: 1,
      failed: 0,
    });

    expect(issueAssignmentService.addLabel).toHaveBeenCalledWith(
      "CPDEV-11",
      "PFOS",
      "qual-token",
    );
    expect(issueAssignmentService.assignIssueToAgent).toHaveBeenCalledWith(
      issue,
      qualifierAgent,
      expect.objectContaining({
        qualifierMode: "fresh",
        fullIssue: issue,
      }),
    );
    expect(db.markOneShotDashboardRunRequestTaskCreated).toHaveBeenCalledWith(
      11,
      321,
    );
  });

  it("does not add PFOS again when the Jira issue already carries the label", async () => {
    const request = {
      id: 12,
      jira_key: "CPDEV-12",
    };
    const qualifierAgent = {
      id: 5,
      name: "QUALIFIER",
      is_active: true,
      jira_token: "qual-token",
    };
    const issue = {
      key: "CPDEV-12",
      fields: {
        labels: ["pfos"],
      },
    };

    const queryMock = vi.fn().mockResolvedValue([[]]);
    const db = {
      claimNextOneShotDashboardRunRequest: vi
        .fn()
        .mockResolvedValueOnce(request)
        .mockResolvedValueOnce(null),
      getAgentByName: vi.fn().mockResolvedValue(qualifierAgent),
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      markOneShotDashboardRunRequestTaskCreated: vi.fn().mockResolvedValue(undefined),
      markOneShotDashboardRunRequestFailed: vi.fn().mockResolvedValue(undefined),
      getPool: vi.fn().mockReturnValue({
        query: queryMock,
      }),
    };
    const oneShotService = {
      getLatestRunByJiraKey: vi.fn().mockResolvedValue(null),
    };
    const issueAssignmentService = {
      fetchJiraIssue: vi.fn().mockResolvedValue(issue),
      addLabel: vi.fn().mockResolvedValue(undefined),
      assignIssueToAgent: vi.fn().mockResolvedValue({
        taskManagementId: 654,
        disposition: "created",
      }),
      extractCustomerFromJira: vi.fn().mockReturnValue(null),
    };

    const processor = new OneShotDashboardRunRequestProcessor(
      db as never,
      oneShotService as never,
      issueAssignmentService as never,
    );

    await processor.processQueuedRequests();

    expect(issueAssignmentService.addLabel).not.toHaveBeenCalled();
    expect(db.markOneShotDashboardRunRequestFailed).not.toHaveBeenCalled();
  });

  it("continues queued processing for blocked-client-shaped tickets so QUALIFIER can reject", async () => {
    const request = {
      id: 13,
      jira_key: "CPDEV-13",
    };
    const qualifierAgent = {
      id: 5,
      name: "QUALIFIER",
      is_active: true,
      jira_token: "qual-token",
    };
    const issue = {
      key: "CPDEV-13",
      fields: {
        labels: [],
        Client: "Blocked Corp",
      },
    };

    const blockedQueryMock = vi.fn().mockResolvedValue([
      [
        {
          client_key: "blocked corp",
          display_name: "Blocked Corp",
          reason: "Contract exclusion",
        },
      ],
    ]);
    const db = {
      claimNextOneShotDashboardRunRequest: vi
        .fn()
        .mockResolvedValueOnce(request)
        .mockResolvedValueOnce(null),
      getAgentByName: vi.fn().mockResolvedValue(qualifierAgent),
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      markOneShotDashboardRunRequestTaskCreated: vi.fn().mockResolvedValue(undefined),
      markOneShotDashboardRunRequestFailed: vi.fn().mockResolvedValue(undefined),
      getPool: vi.fn().mockReturnValue({
        query: blockedQueryMock,
      }),
    };
    const oneShotService = {
      getLatestRunByJiraKey: vi.fn().mockResolvedValue(null),
    };
    const issueAssignmentService = {
      fetchJiraIssue: vi.fn().mockResolvedValue(issue),
      addLabel: vi.fn().mockResolvedValue(undefined),
      assignIssueToAgent: vi.fn().mockResolvedValue({ taskManagementId: 999, disposition: "created" }),
      extractCustomerFromJira: vi.fn().mockReturnValue("Blocked Corp"),
    };

    const processor = new OneShotDashboardRunRequestProcessor(
      db as never,
      oneShotService as never,
      issueAssignmentService as never,
    );

    await expect(processor.processQueuedRequests()).resolves.toEqual({
      processed: 1,
      failed: 0,
    });

    expect(blockedQueryMock).not.toHaveBeenCalled();
    expect(issueAssignmentService.addLabel).toHaveBeenCalledWith(
      "CPDEV-13",
      "PFOS",
      "qual-token",
    );
    expect(issueAssignmentService.assignIssueToAgent).toHaveBeenCalledWith(
      issue,
      qualifierAgent,
      expect.objectContaining({
        qualifierMode: "fresh",
        fullIssue: issue,
      }),
    );
    expect(db.markOneShotDashboardRunRequestTaskCreated).toHaveBeenCalledWith(
      13,
      999,
    );
    expect(db.markOneShotDashboardRunRequestFailed).not.toHaveBeenCalled();
  });

  it("continues processing when the client is not on the blocked list", async () => {
    const request = {
      id: 14,
      jira_key: "CPDEV-14",
    };
    const qualifierAgent = {
      id: 5,
      name: "QUALIFIER",
      is_active: true,
      jira_token: "qual-token",
    };
    const issue = {
      key: "CPDEV-14",
      fields: {
        labels: [],
        Customer: "Allowed Client",
      },
    };

    const queryMock = vi.fn().mockResolvedValue([[]]);
    const db = {
      claimNextOneShotDashboardRunRequest: vi
        .fn()
        .mockResolvedValueOnce(request)
        .mockResolvedValueOnce(null),
      getAgentByName: vi.fn().mockResolvedValue(qualifierAgent),
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      markOneShotDashboardRunRequestTaskCreated: vi.fn().mockResolvedValue(undefined),
      markOneShotDashboardRunRequestFailed: vi.fn().mockResolvedValue(undefined),
      getPool: vi.fn().mockReturnValue({
        query: queryMock,
      }),
    };
    const oneShotService = {
      getLatestRunByJiraKey: vi.fn().mockResolvedValue(null),
    };
    const issueAssignmentService = {
      fetchJiraIssue: vi.fn().mockResolvedValue(issue),
      addLabel: vi.fn().mockResolvedValue(undefined),
      assignIssueToAgent: vi.fn().mockResolvedValue({ taskManagementId: 888, disposition: "created" }),
      extractCustomerFromJira: vi.fn().mockReturnValue("Allowed Client"),
    };

    const processor = new OneShotDashboardRunRequestProcessor(
      db as never,
      oneShotService as never,
      issueAssignmentService as never,
    );

    await expect(processor.processQueuedRequests()).resolves.toEqual({
      processed: 1,
      failed: 0,
    });

    expect(queryMock).not.toHaveBeenCalled();
    expect(db.markOneShotDashboardRunRequestFailed).not.toHaveBeenCalled();
    expect(db.markOneShotDashboardRunRequestTaskCreated).toHaveBeenCalledWith(14, 888);
  });

  it("continues processing when no client can be extracted from the issue", async () => {
    const request = {
      id: 15,
      jira_key: "CPDEV-15",
    };
    const qualifierAgent = {
      id: 5,
      name: "QUALIFIER",
      is_active: true,
      jira_token: "qual-token",
    };
    const issue = {
      key: "CPDEV-15",
      fields: {
        labels: [],
      },
    };

    const queryMock = vi.fn();
    const db = {
      claimNextOneShotDashboardRunRequest: vi
        .fn()
        .mockResolvedValueOnce(request)
        .mockResolvedValueOnce(null),
      getAgentByName: vi.fn().mockResolvedValue(qualifierAgent),
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      markOneShotDashboardRunRequestTaskCreated: vi.fn().mockResolvedValue(undefined),
      markOneShotDashboardRunRequestFailed: vi.fn().mockResolvedValue(undefined),
      getPool: vi.fn().mockReturnValue({ query: queryMock }),
    };
    const oneShotService = {
      getLatestRunByJiraKey: vi.fn().mockResolvedValue(null),
    };
    const issueAssignmentService = {
      fetchJiraIssue: vi.fn().mockResolvedValue(issue),
      addLabel: vi.fn().mockResolvedValue(undefined),
      assignIssueToAgent: vi.fn().mockResolvedValue({ taskManagementId: 777, disposition: "created" }),
      extractCustomerFromJira: vi.fn().mockReturnValue(null),
    };

    const processor = new OneShotDashboardRunRequestProcessor(
      db as never,
      oneShotService as never,
      issueAssignmentService as never,
    );

    await processor.processQueuedRequests();

    // No blocked-client query should be issued
    expect(queryMock).not.toHaveBeenCalled();
    expect(db.markOneShotDashboardRunRequestFailed).not.toHaveBeenCalled();
  });

  it("continues processing when the blocked-client policy store is unavailable", async () => {
    const request = {
      id: 16,
      jira_key: "CPDEV-16",
    };
    const qualifierAgent = {
      id: 5,
      name: "QUALIFIER",
      is_active: true,
      jira_token: "qual-token",
    };
    const issue = {
      key: "CPDEV-16",
      fields: {
        labels: [],
        customer: "Blocked Corp",
      },
    };

    const queryMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("No table"), { code: "ER_NO_SUCH_TABLE" }),
    );
    const db = {
      claimNextOneShotDashboardRunRequest: vi
        .fn()
        .mockResolvedValueOnce(request)
        .mockResolvedValueOnce(null),
      getAgentByName: vi.fn().mockResolvedValue(qualifierAgent),
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      markOneShotDashboardRunRequestTaskCreated: vi.fn().mockResolvedValue(undefined),
      markOneShotDashboardRunRequestFailed: vi.fn().mockResolvedValue(undefined),
      getPool: vi.fn().mockReturnValue({ query: queryMock }),
    };
    const oneShotService = {
      getLatestRunByJiraKey: vi.fn().mockResolvedValue(null),
    };
    const issueAssignmentService = {
      fetchJiraIssue: vi.fn().mockResolvedValue(issue),
      addLabel: vi.fn().mockResolvedValue(undefined),
      assignIssueToAgent: vi.fn().mockResolvedValue({ taskManagementId: 889, disposition: "created" }),
      extractCustomerFromJira: vi.fn().mockReturnValue("Blocked Corp"),
    };

    const processor = new OneShotDashboardRunRequestProcessor(
      db as never,
      oneShotService as never,
      issueAssignmentService as never,
    );

    await expect(processor.processQueuedRequests()).resolves.toEqual({
      processed: 1,
      failed: 0,
    });

    expect(issueAssignmentService.addLabel).toHaveBeenCalledWith(
      "CPDEV-16",
      "PFOS",
      "qual-token",
    );
    expect(queryMock).not.toHaveBeenCalled();
    expect(db.markOneShotDashboardRunRequestTaskCreated).toHaveBeenCalledWith(
      16,
      889,
    );
  });
});
