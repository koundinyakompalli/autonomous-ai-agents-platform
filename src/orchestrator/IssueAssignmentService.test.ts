import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildQualifierRepoConfirmationDashboardUrl,
  canRequeueExistingTaskManagementRow,
  IssueAssignmentService,
} from "./IssueAssignmentService.js";

const CLIENT_ASSETS_EXPAND =
  "names,customfield_10769.cmdb.label,customfield_10769.cmdb.attributes";

describe("buildQualifierRepoConfirmationDashboardUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes a dashboard host without /oneshot", () => {
    expect(
      buildQualifierRepoConfirmationDashboardUrl(
        "https://productFactory.mhkdevsandbox.com",
        1234,
      ),
    ).toBe(
      "https://productFactory.mhkdevsandbox.com/oneshot?view=waiting&run=qualifier-task-1234",
    );
  });

  it("normalizes a dashboard host that already includes /oneshot", () => {
    expect(
      buildQualifierRepoConfirmationDashboardUrl(
        "https://productFactory.mhkdevsandbox.com/oneshot/",
        1234,
      ),
    ).toBe(
      "https://productFactory.mhkdevsandbox.com/oneshot?view=waiting&run=qualifier-task-1234",
    );
  });
});

describe("canRequeueExistingTaskManagementRow", () => {
  it("requeues non-QUALIFIER failed rows only while attempts remain", () => {
    expect(
      canRequeueExistingTaskManagementRow(
        { status: "failed", retry_count: 2 },
        false,
      ),
    ).toBe(true);
    expect(
      canRequeueExistingTaskManagementRow(
        { status: "failed", retry_count: 3 },
        false,
      ),
    ).toBe(false);
    expect(
      canRequeueExistingTaskManagementRow(
        { status: "failed_retries_exhausted", retry_count: 3 },
        false,
      ),
    ).toBe(false);
  });
});

describe("IssueAssignmentService routing Jira fetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches expand=names fields and paginated comments for routing", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: URL | RequestInfo) => {
        const href = String(url);
        if (href.includes("/comment?")) {
          return new Response(
            JSON.stringify({
              comments: [{ id: "c1", body: "comment repo hint" }],
              startAt: 0,
              maxResults: 100,
              total: 1,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            key: "CPDEV-21311",
            names: { customfield_123: "Acceptance Criteria" },
            fields: {
              summary: "Use interop",
              description: "description",
              labels: ["PFOS"],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

    const service = new IssueAssignmentService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        jiraBaseUrl: "https://jira.example",
        jiraToken: "token",
        jiraUsername: "user",
      },
    );

    const issue = await service.fetchJiraIssue("CPDEV-21311");

    expect(issue.names?.customfield_123).toBe("Acceptance Criteria");
    expect((issue.fields.comment as any).comments).toHaveLength(1);
    const issueUrl = new URL(fetchMock.mock.calls[0]?.[0]?.toString() ?? "");
    expect(issueUrl.searchParams.get("expand")).toBe(CLIENT_ASSETS_EXPAND);
    expect(issueUrl.searchParams.get("fields")).toBe("*all");
    expect(fetchMock.mock.calls[1]?.[0]?.toString()).toContain("/comment?");
  });
});

describe("IssueAssignmentService non-QUALIFIER repo analysis", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes non-QUALIFIER agents through RepoAnalyzer (RepoRouter is QUALIFIER-only)", async () => {
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      getDefaultCustomerBranch: vi.fn().mockResolvedValue({
        id: 25,
        customer: "Default",
        branch: "main",
      }),
      getAllRepositories: vi.fn().mockResolvedValue([
        {
          id: 2,
          repo_name: "batch-jobs",
          repo_url: "https://github.com/mhk-repos/cp-batch-monorepo.git",
          default_branch: "master",
        },
      ]),
      createTaskManagement: vi.fn().mockResolvedValue(77),
    };
    const storage = {
      uploadTaskDescription: vi.fn().mockResolvedValue({
        bucket: "tasks",
        key: "task.json",
      }),
    };
    const taskDescriptionGenerator = {
      generateFromTicketKey: vi.fn().mockResolvedValue("Task description"),
    };
    const repoAnalyzer = {
      analyzeTicketForRepos: vi.fn().mockResolvedValue({
        selectedRepoIds: [2],
        reasoning: "batch analyzer",
      }),
    };
    const service = new IssueAssignmentService(
      db as any,
      storage as any,
      taskDescriptionGenerator as any,
      repoAnalyzer as any,
      {
        jiraBaseUrl: "https://jira.example",
        jiraToken: "token",
        jiraUsername: "user",
      },
    );

    await service.assignIssueToAgent(
      {
        key: "CPDEV-22308",
        fields: {
          summary: "Fax Intake",
          description: "non-qualifier agent",
        },
      },
      {
        id: 9,
        name: "PRISM",
        task_type: "prism",
        jira_token: "agent-token",
      } as any,
      {
        fullIssue: {
          key: "CPDEV-22308",
          fields: {
            summary: "Fax Intake",
            description: "non-qualifier agent",
          },
        },
      },
    );

    expect(repoAnalyzer.analyzeTicketForRepos).toHaveBeenCalled();
    expect(db.createTaskManagement).toHaveBeenCalledWith(
      expect.objectContaining({
        related_code: "2",
        task_type: "prism",
        status: "assigned",
      }),
    );
  });

  it("does not reassign a non-QUALIFIER ticket when the existing row is already posted", async () => {
    const existing = {
      id: 2533,
      jira_number: "CPDEV-22680",
      agent_id: 1,
      customer_id: 25,
      related_code: "1",
      task_type: "darci",
      status: "posted_to_jira",
      source: "jira",
      retry_count: 0,
      created_at: new Date(0),
      updated_at: new Date(0),
    };
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(existing),
      getDefaultCustomerBranch: vi.fn(),
      getAllRepositories: vi.fn(),
      createTaskManagement: vi.fn(),
      requeueTaskManagement: vi.fn(),
    };
    const storage = {
      uploadTaskDescription: vi.fn(),
    };
    const taskDescriptionGenerator = {
      generateFromTicketKey: vi.fn(),
    };
    const repoAnalyzer = {
      analyzeTicketForRepos: vi.fn(),
    };
    const service = new IssueAssignmentService(
      db as any,
      storage as any,
      taskDescriptionGenerator as any,
      repoAnalyzer as any,
      {
        jiraBaseUrl: "https://jira.example",
        jiraToken: "token",
        jiraUsername: "user",
      },
    );

    const result = await service.assignIssueToAgent(
      {
        key: "CPDEV-22680",
        fields: {
          summary: "Discharge Date error",
          description: "Provider Portal",
        },
      },
      {
        id: 1,
        name: "DARCI",
        task_type: "darci",
        jira_token: "agent-token",
      } as any,
      {
        existingTaskManagement: existing as any,
        fullIssue: {
          key: "CPDEV-22680",
          fields: {
            summary: "Discharge Date error",
            description: "Provider Portal",
          },
        },
      },
    );

    expect(result).toMatchObject({
      taskManagementId: 2533,
      disposition: "existing_active",
    });
    expect(
      taskDescriptionGenerator.generateFromTicketKey,
    ).not.toHaveBeenCalled();
    expect(storage.uploadTaskDescription).not.toHaveBeenCalled();
    expect(repoAnalyzer.analyzeTicketForRepos).not.toHaveBeenCalled();
    expect(db.createTaskManagement).not.toHaveBeenCalled();
    expect(db.requeueTaskManagement).not.toHaveBeenCalled();
  });

  it("requeues a failed non-QUALIFIER ticket below the attempt cap", async () => {
    const existing = {
      id: 2534,
      jira_number: "CPDEV-22681",
      agent_id: 1,
      customer_id: 25,
      related_code: "1",
      task_type: "darci",
      status: "failed",
      source: "jira",
      retry_count: 2,
      created_at: new Date(0),
      updated_at: new Date(0),
    };
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(existing),
      getDefaultCustomerBranch: vi.fn().mockResolvedValue({
        id: 25,
        customer: "Default",
        branch: "main",
      }),
      getAllRepositories: vi.fn().mockResolvedValue([
        {
          id: 1,
          repo_name: "core-app",
          repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          default_branch: "master",
        },
      ]),
      createTaskManagement: vi.fn(),
      requeueTaskManagement: vi.fn().mockResolvedValue(undefined),
    };
    const storage = {
      uploadTaskDescription: vi.fn().mockResolvedValue({
        bucket: "tasks",
        key: "tasks/CPDEV-22681.md",
      }),
    };
    const taskDescriptionGenerator = {
      generateFromTicketKey: vi.fn().mockResolvedValue("New task description"),
    };
    const repoAnalyzer = {
      analyzeTicketForRepos: vi.fn().mockResolvedValue({
        selectedRepoIds: [1],
        reasoning: "core app route",
      }),
    };
    const service = new IssueAssignmentService(
      db as any,
      storage as any,
      taskDescriptionGenerator as any,
      repoAnalyzer as any,
      {
        jiraBaseUrl: "https://jira.example",
        jiraToken: "token",
        jiraUsername: "user",
      },
    );

    const result = await service.assignIssueToAgent(
      {
        key: "CPDEV-22681",
        fields: {
          summary: "Retry failed DARCI task",
          description: "Still labeled DARCI",
        },
      },
      {
        id: 1,
        name: "DARCI",
        task_type: "darci",
        jira_token: "agent-token",
      } as any,
      {
        existingTaskManagement: existing as any,
        fullIssue: {
          key: "CPDEV-22681",
          fields: {
            summary: "Retry failed DARCI task",
            description: "Still labeled DARCI",
          },
        },
      },
    );

    expect(result).toMatchObject({
      taskManagementId: 2534,
      disposition: "requeued",
    });
    expect(db.createTaskManagement).not.toHaveBeenCalled();
    expect(db.requeueTaskManagement).toHaveBeenCalledWith(
      2534,
      expect.objectContaining({
        customer_id: 25,
        related_code: "1",
        task_type: "darci",
        status: "assigned",
        retry_count: 2,
      }),
    );
    expect(taskDescriptionGenerator.generateFromTicketKey).toHaveBeenCalledWith(
      "CPDEV-22681",
      "agent-token",
    );
  });

  it("does not requeue a failed non-QUALIFIER ticket after the attempt cap", async () => {
    const existing = {
      id: 2535,
      jira_number: "MPSUP-4947",
      agent_id: 10,
      customer_id: 25,
      related_code: "1",
      task_type: "log_analysis",
      status: "failed",
      source: "jira",
      retry_count: 3,
      error_message: "No .log attachments found",
      created_at: new Date(0),
      updated_at: new Date(0),
    };
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(existing),
      getDefaultCustomerBranch: vi.fn(),
      getAllRepositories: vi.fn(),
      createTaskManagement: vi.fn(),
      requeueTaskManagement: vi.fn(),
    };
    const storage = {
      uploadTaskDescription: vi.fn(),
    };
    const taskDescriptionGenerator = {
      generateFromTicketKey: vi.fn(),
    };
    const repoAnalyzer = {
      analyzeTicketForRepos: vi.fn(),
    };
    const service = new IssueAssignmentService(
      db as any,
      storage as any,
      taskDescriptionGenerator as any,
      repoAnalyzer as any,
      {
        jiraBaseUrl: "https://jira.example",
        jiraToken: "token",
        jiraUsername: "user",
      },
    );

    const result = await service.assignIssueToAgent(
      {
        key: "MPSUP-4947",
        fields: {
          summary: "SQL log issue",
          description: "Still labeled SRLOG",
        },
      },
      {
        id: 10,
        name: "SRLOG",
        task_type: "log_analysis",
        jira_token: "agent-token",
      } as any,
      {
        existingTaskManagement: existing as any,
        fullIssue: {
          key: "MPSUP-4947",
          fields: {
            summary: "SQL log issue",
            description: "Still labeled SRLOG",
          },
        },
      },
    );

    expect(result).toMatchObject({
      taskManagementId: 2535,
      disposition: "existing_active",
    });
    expect(
      taskDescriptionGenerator.generateFromTicketKey,
    ).not.toHaveBeenCalled();
    expect(storage.uploadTaskDescription).not.toHaveBeenCalled();
    expect(repoAnalyzer.analyzeTicketForRepos).not.toHaveBeenCalled();
    expect(db.createTaskManagement).not.toHaveBeenCalled();
    expect(db.requeueTaskManagement).not.toHaveBeenCalled();
  });
});

describe("IssueAssignmentService QUALIFIER intake (LLM owns repo selection)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildService(overrides: {
    db: any;
    storage?: any;
    taskDescriptionGenerator?: any;
  }) {
    const storage = overrides.storage ?? {
      uploadTaskDescription: vi.fn().mockResolvedValue({
        bucket: "tasks",
        key: "task.json",
      }),
      uploadTicketEvidence: vi.fn().mockResolvedValue({
        bucket: "tasks",
        key: "task.ticket-evidence.v1.json",
      }),
    };
    const taskDescriptionGenerator = overrides.taskDescriptionGenerator ?? {
      generateFromTicketKey: vi.fn().mockResolvedValue("Task description"),
    };
    return {
      service: new IssueAssignmentService(
        overrides.db,
        storage,
        taskDescriptionGenerator,
        {} as any,
        {
          jiraBaseUrl: "https://jira.example",
          jiraToken: "token",
          jiraUsername: "user",
        },
      ),
      storage,
      taskDescriptionGenerator,
    };
  }

  it("creates a QUALIFIER task with empty related_code and status=assigned, never calling RepoRouter", async () => {
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      getDefaultCustomerBranch: vi.fn().mockResolvedValue({
        id: 25,
        customer: "Default",
        branch: "main",
      }),
      getAllRepositories: vi.fn().mockResolvedValue([]),
      createTaskManagement: vi.fn().mockResolvedValue(77),
    };
    const { service, taskDescriptionGenerator, storage } = buildService({ db });

    const result = await service.assignIssueToAgent(
      {
        key: "CPDEV-30001",
        fields: {
          summary: "Add a Cancel button",
          description: "Repo: cp-mhk-smart-prominence",
          labels: ["PFOS"],
        },
      },
      {
        id: 3,
        name: "QUALIFIER",
        task_type: "qualifier",
        jira_token: "agent-token",
      } as any,
      {
        fullIssue: {
          key: "CPDEV-30001",
          fields: {
            summary: "Add a Cancel button",
            description: "Repo: cp-mhk-smart-prominence",
            labels: ["PFOS"],
          },
        },
      },
    );

    expect(result).toMatchObject({
      taskManagementId: 77,
      disposition: "created",
    });
    expect(taskDescriptionGenerator.generateFromTicketKey).toHaveBeenCalledWith(
      "CPDEV-30001",
      "agent-token",
    );
    expect(storage.uploadTaskDescription).toHaveBeenCalled();
    expect(db.createTaskManagement).toHaveBeenCalledWith(
      expect.objectContaining({
        jira_number: "CPDEV-30001",
        agent_id: 3,
        related_code: "",
        task_type: "qualifier",
        status: "assigned",
      }),
    );
    expect(db.getAllRepositories).not.toHaveBeenCalled();
  });

  it("uploads ticket evidence beside the task description for QUALIFIER payloads", async () => {
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      getDefaultCustomerBranch: vi.fn().mockResolvedValue({
        id: 25,
        customer: "Default",
        branch: "main",
      }),
      getAllRepositories: vi.fn().mockResolvedValue([]),
      createTaskManagement: vi.fn().mockResolvedValue(77),
    };
    const storage = {
      uploadTaskDescription: vi.fn().mockResolvedValue({
        bucket: "tasks",
        key: "tasks/CPDEV-30002/2026-06-17.md",
      }),
      uploadTicketEvidence: vi.fn().mockResolvedValue({
        bucket: "tasks",
        key: "tasks/CPDEV-30002/2026-06-17.ticket-evidence.v1.json",
      }),
    };
    const ticketEvidence = {
      schemaVersion: "ticket-evidence.v1",
      jiraKey: "CPDEV-30002",
      stats: {
        commentCount: 2,
        attachmentCount: 1,
        extractedAttachmentCount: 1,
        imageAttachmentCount: 0,
        warningCount: 0,
      },
    };
    const taskDescriptionGenerator = {
      generateTaskPayloadFromTicketKey: vi.fn().mockResolvedValue({
        taskDescription: "Generated summary",
        ticketEvidence,
      }),
      generateFromTicketKey: vi.fn(),
    };
    const { service } = buildService({
      db,
      storage,
      taskDescriptionGenerator,
    });

    await service.assignIssueToAgent(
      {
        key: "CPDEV-30002",
        fields: {
          summary: "Planner evidence",
          description: "Repo: cp-medhok-monorepo",
          labels: ["PFOS"],
        },
      },
      {
        id: 3,
        name: "QUALIFIER",
        task_type: "qualifier",
        jira_token: "agent-token",
      } as any,
      {
        fullIssue: {
          key: "CPDEV-30002",
          fields: {
            summary: "Planner evidence",
            description: "Repo: cp-medhok-monorepo",
            labels: ["PFOS"],
          },
        },
      },
    );

    expect(
      taskDescriptionGenerator.generateTaskPayloadFromTicketKey,
    ).toHaveBeenCalledWith("CPDEV-30002", "agent-token");
    expect(taskDescriptionGenerator.generateFromTicketKey).not.toHaveBeenCalled();
    expect(storage.uploadTaskDescription).toHaveBeenCalledWith(
      "CPDEV-30002",
      "Generated summary",
    );
    expect(storage.uploadTicketEvidence).toHaveBeenCalledWith(
      "CPDEV-30002",
      "tasks/CPDEV-30002/2026-06-17.md",
      ticketEvidence,
    );
    expect(db.createTaskManagement).toHaveBeenCalledWith(
      expect.objectContaining({
        task_s3_bucket: "tasks",
        task_s3_key: "tasks/CPDEV-30002/2026-06-17.md",
      }),
    );
  });

  it("continues QUALIFIER task creation when ticket evidence upload fails after task description upload", async () => {
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      getDefaultCustomerBranch: vi.fn().mockResolvedValue({
        id: 25,
        customer: "Default",
        branch: "main",
      }),
      getAllRepositories: vi.fn().mockResolvedValue([]),
      createTaskManagement: vi.fn().mockResolvedValue(77),
    };
    const storage = {
      uploadTaskDescription: vi.fn().mockResolvedValue({
        bucket: "tasks",
        key: "tasks/CPDEV-30003/2026-06-17.md",
      }),
      uploadTicketEvidence: vi.fn().mockRejectedValue(new Error("s3 throttle")),
    };
    const taskDescriptionGenerator = {
      generateTaskPayloadFromTicketKey: vi.fn().mockResolvedValue({
        taskDescription: "Generated summary",
        ticketEvidence: {
          schemaVersion: "ticket-evidence.v1",
          jiraKey: "CPDEV-30003",
          stats: {
            commentCount: 0,
            attachmentCount: 0,
            extractedAttachmentCount: 0,
            imageAttachmentCount: 0,
            warningCount: 0,
          },
        },
      }),
      generateFromTicketKey: vi.fn(),
    };
    const { service } = buildService({
      db,
      storage,
      taskDescriptionGenerator,
    });

    const result = await service.assignIssueToAgent(
      {
        key: "CPDEV-30003",
        fields: {
          summary: "Planner evidence upload can fail",
          description: "Repo: cp-medhok-monorepo",
          labels: ["PFOS"],
        },
      },
      {
        id: 3,
        name: "QUALIFIER",
        task_type: "qualifier",
        jira_token: "agent-token",
      } as any,
      {
        fullIssue: {
          key: "CPDEV-30003",
          fields: {
            summary: "Planner evidence upload can fail",
            description: "Repo: cp-medhok-monorepo",
            labels: ["PFOS"],
          },
        },
      },
    );

    expect(result).toMatchObject({
      taskManagementId: 77,
      disposition: "created",
    });
    expect(storage.uploadTicketEvidence).toHaveBeenCalled();
    expect(db.createTaskManagement).toHaveBeenCalledWith(
      expect.objectContaining({
        task_s3_bucket: "tasks",
        task_s3_key: "tasks/CPDEV-30003/2026-06-17.md",
      }),
    );
  });

  it("requeues an existing QUALIFIER task with related_code cleared, regardless of stale value", async () => {
    const existing = {
      id: 2489,
      jira_number: "CPDEV-22347",
      agent_id: 3,
      customer_id: 25,
      related_code: "3",
      task_type: "qualifier",
      status: "posted_to_jira",
      source: "jira",
      retry_count: 0,
      created_at: new Date(0),
      updated_at: new Date(0),
    };
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(existing),
      getDefaultCustomerBranch: vi.fn().mockResolvedValue({
        id: 25,
        customer: "Default",
        branch: "main",
      }),
      getAllRepositories: vi.fn().mockResolvedValue([]),
      requeueTaskManagement: vi.fn().mockResolvedValue(undefined),
    };
    const { service } = buildService({ db });

    const result = await service.assignIssueToAgent(
      {
        key: "CPDEV-22347",
        fields: {
          summary: "Medical Appeals date field",
          description: "Technical Details:\nrepo: cp-mhk-smart-prominence",
          labels: ["PFOS"],
        },
      },
      {
        id: 3,
        name: "QUALIFIER",
        task_type: "qualifier",
        jira_token: "agent-token",
      } as any,
      {
        existingTaskManagement: existing as any,
        fullIssue: {
          key: "CPDEV-22347",
          fields: {
            summary: "Medical Appeals date field",
            description: "Technical Details:\nrepo: cp-mhk-smart-prominence",
            labels: ["PFOS"],
          },
        },
      },
    );

    expect(result).toMatchObject({
      taskManagementId: 2489,
      disposition: "requeued",
    });
    expect(db.requeueTaskManagement).toHaveBeenCalledWith(
      2489,
      expect.objectContaining({
        customer_id: 25,
        related_code: "",
        task_type: "qualifier",
        status: "assigned",
      }),
    );
  });
});

describe("IssueAssignmentService MERIDIAN assignment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assigns MERIDIAN without repo analysis, task-description LLM, or S3 upload", async () => {
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      getDefaultCustomerBranch: vi.fn().mockResolvedValue({
        id: 25,
        customer: "Default",
        branch: "main",
      }),
      createTaskManagement: vi.fn().mockResolvedValue(88),
    };
    const storage = {
      uploadTaskDescription: vi.fn(),
    };
    const taskDescriptionGenerator = {
      generateFromTicketKey: vi.fn(),
    };
    const repoAnalyzer = {
      analyzeTicketForRepos: vi.fn(),
    };
    const service = new IssueAssignmentService(
      db as any,
      storage as any,
      taskDescriptionGenerator as any,
      repoAnalyzer as any,
      {
        jiraBaseUrl: "https://jira.example",
        jiraToken: "token",
        jiraUsername: "user",
      },
    );

    const result = await service.assignIssueToAgent(
      {
        key: "CPSUP-48528",
        fields: {
          summary: "BSC backend update",
          labels: ["MERIDIAN"],
        },
      },
      {
        id: 12,
        name: "MERIDIAN",
        task_type: "sql_generation",
        jira_token: "agent-token",
      } as any,
      {
        fullIssue: {
          key: "CPSUP-48528",
          fields: {
            summary: "BSC backend update",
            labels: ["MERIDIAN"],
          },
        },
      },
    );

    expect(result).toMatchObject({ taskManagementId: 88, disposition: "created" });
    expect(repoAnalyzer.analyzeTicketForRepos).not.toHaveBeenCalled();
    expect(taskDescriptionGenerator.generateFromTicketKey).not.toHaveBeenCalled();
    expect(storage.uploadTaskDescription).not.toHaveBeenCalled();
    expect(db.createTaskManagement).toHaveBeenCalledWith(
      expect.objectContaining({
        jira_number: "CPSUP-48528",
        related_code: "",
        task_type: "sql_generation",
        status: "assigned",
      }),
    );
  });
});

describe("IssueAssignmentService MERIDIAN assignment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assigns MERIDIAN without repo analysis, task-description LLM, or S3 upload", async () => {
    const db = {
      getTaskManagementByJiraAndAgent: vi.fn().mockResolvedValue(null),
      getDefaultCustomerBranch: vi.fn().mockResolvedValue({
        id: 25,
        customer: "Default",
        branch: "main",
      }),
      createTaskManagement: vi.fn().mockResolvedValue(88),
    };
    const storage = {
      uploadTaskDescription: vi.fn(),
    };
    const taskDescriptionGenerator = {
      generateFromTicketKey: vi.fn(),
    };
    const repoAnalyzer = {
      analyzeTicketForRepos: vi.fn(),
    };
    const service = new IssueAssignmentService(
      db as any,
      storage as any,
      taskDescriptionGenerator as any,
      repoAnalyzer as any,
      {
        jiraBaseUrl: "https://jira.example",
        jiraToken: "token",
        jiraUsername: "user",
      },
    );

    const result = await service.assignIssueToAgent(
      {
        key: "CPSUP-48528",
        fields: {
          summary: "BSC backend update",
          labels: ["MERIDIAN"],
        },
      },
      {
        id: 12,
        name: "MERIDIAN",
        task_type: "sql_generation",
        jira_token: "agent-token",
      } as any,
      {
        fullIssue: {
          key: "CPSUP-48528",
          fields: {
            summary: "BSC backend update",
            labels: ["MERIDIAN"],
          },
        },
      },
    );

    expect(result).toMatchObject({ taskManagementId: 88, disposition: "created" });
    expect(repoAnalyzer.analyzeTicketForRepos).not.toHaveBeenCalled();
    expect(taskDescriptionGenerator.generateFromTicketKey).not.toHaveBeenCalled();
    expect(storage.uploadTaskDescription).not.toHaveBeenCalled();
    expect(db.createTaskManagement).toHaveBeenCalledWith(
      expect.objectContaining({
        jira_number: "CPSUP-48528",
        related_code: "",
        task_type: "sql_generation",
        status: "assigned",
      }),
    );
  });
});
