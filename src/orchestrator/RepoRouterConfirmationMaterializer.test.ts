import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildQualifierConfirmationPlan } from "../oneshot/qualifier-confirmation-plan.js";
import { RepoRouterConfirmationMaterializer } from "./RepoRouterConfirmationMaterializer.js";
import type { CodeRepository, Database } from "./database.js";
import type { IssueAssignmentService } from "./IssueAssignmentService.js";
import type { Storage } from "./storage.js";
import type { TaskDescriptionGenerator } from "./TaskDescriptionGenerator.js";

const repos: CodeRepository[] = [
  {
    id: 1,
    repo_name: "interop",
    repo_url: "https://example.com/interop.git",
    description: "Interop",
    created_at: new Date(),
  },
  {
    id: 2,
    repo_name: "core-app",
    repo_url: "https://example.com/core-app.git",
    description: "Core App",
    created_at: new Date(),
  },
];

const ticketIssue = {
  key: "CPDEV-21311",
  fields: {
    summary: "Update interop",
    created: "2026-04-01T00:00:00.000Z",
  },
} as any;

function makeMatchingPendingRow(overrides: Record<string, unknown> = {}) {
  // Compute the expected snapshot hash for the current repo set so the
  // operator's selection matches and materialization proceeds.
  const referencePlan = buildQualifierConfirmationPlan({
    ticket: ticketIssue,
    availableRepos: repos,
    selectedRepoIds: [1],
  });
  return {
    id: 10,
    ticket_id: "CPDEV-21311",
    task_management_id: 1234,
    snapshot_hash: referencePlan.snapshotHash,
    resolved_repo_id: 1,
    resolved_by: "operator",
    resolution_source: "dashboard",
    related_code: "",
    retry_count: 0,
    updated_at: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

function createHarness(
  options: {
    rows?: unknown[];
    availableRepos?: CodeRepository[];
    generatorError?: Error;
  } = {},
) {
  const poolQuery = vi.fn(async (sql: string) => {
    if (sql.includes("FROM router_confirmations rc")) {
      return [options.rows ?? [makeMatchingPendingRow()], undefined];
    }
    if (sql.includes("UPDATE router_confirmations")) {
      return [{ affectedRows: 1 }, undefined];
    }
    if (sql.includes("UPDATE task_management")) {
      return [{ affectedRows: 1 }, undefined];
    }
    throw new Error(`Unexpected pool SQL: ${sql}`);
  });
  const connectionQuery = vi.fn(async (sql: string) => {
    if (
      sql.includes("UPDATE task_management") ||
      sql.includes("UPDATE router_confirmations")
    ) {
      return [{ affectedRows: 1 }, undefined];
    }
    throw new Error(`Unexpected connection SQL: ${sql}`);
  });
  const connection = {
    beginTransaction: vi.fn(),
    query: connectionQuery,
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
  const db = {
    getPool: () =>
      ({
        query: poolQuery,
        getConnection: vi.fn().mockResolvedValue(connection),
      }) as never,
    getAgentByName: vi.fn().mockResolvedValue({
      id: 7,
      name: "QUALIFIER",
      jira_token: "token",
      is_active: true,
      task_type: "QUALIFIER",
    }),
    getAllRepositories: vi
      .fn()
      .mockResolvedValue(options.availableRepos ?? repos),
    createRouterDecision: vi.fn().mockResolvedValue(99),
  } as unknown as Database;
  const storage = {
    uploadTaskDescription: vi
      .fn()
      .mockResolvedValue({ bucket: "tasks", key: "tasks/CPDEV-21311.md" }),
  } as unknown as Storage;
  const taskDescriptionGenerator = {
    generateFromTicketKey: options.generatorError
      ? vi.fn().mockRejectedValue(options.generatorError)
      : vi.fn().mockResolvedValue("QUALIFIER task"),
  } as unknown as TaskDescriptionGenerator;
  const issueAssignmentService = {
    fetchJiraIssue: vi.fn().mockResolvedValue(ticketIssue),
  } as unknown as IssueAssignmentService;

  return {
    materializer: new RepoRouterConfirmationMaterializer(
      db,
      storage,
      taskDescriptionGenerator,
      issueAssignmentService,
    ),
    db,
    storage,
    taskDescriptionGenerator,
    issueAssignmentService,
    poolQuery,
    connection,
    connectionQuery,
  };
}

describe("RepoRouterConfirmationMaterializer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads the task payload before releasing the task to QUALIFIER", async () => {
    const harness = createHarness();

    const result = await harness.materializer.processPendingSelections();

    expect(result).toMatchObject({ processed: 1, materialized: 1, failed: 0 });
    expect(harness.db.createRouterDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionSource: "qualifier_llm",
        outcome: "needs_repo_confirmation",
      }),
      expect.objectContaining({ taskManagementId: 1234 }),
    );
    expect(
      harness.taskDescriptionGenerator.generateFromTicketKey,
    ).toHaveBeenCalledWith("CPDEV-21311", "token");
    expect(harness.storage.uploadTaskDescription).toHaveBeenCalledWith(
      "CPDEV-21311",
      "QUALIFIER task",
    );
    expect(harness.connectionQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'assigned'"),
      ["1", "tasks", "tasks/CPDEV-21311.md", 1234],
    );
  });

  it("refreshes stale candidates when the enabled repo set has changed since the human picked", async () => {
    // Stored snapshot was computed against [interop, core-app]; now the
    // enabled set is just [interop], so the new plan's hash differs.
    const stalePending = makeMatchingPendingRow();
    const harness = createHarness({
      rows: [stalePending],
      availableRepos: [repos[0]],
    });

    const result = await harness.materializer.processPendingSelections();

    expect(result).toMatchObject({ processed: 1, materialized: 0, stale: 1 });
    expect(harness.connection.beginTransaction).not.toHaveBeenCalled();
    expect(harness.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("resolved_repo_id = NULL"),
      expect.arrayContaining([99, expect.any(String), expect.any(String)]),
    );
  });

  it("refreshes stale candidates when the resolved repo is no longer enabled", async () => {
    // Operator selected repo id 99 which is not in the current enabled set.
    const stalePending = makeMatchingPendingRow({ resolved_repo_id: 99 });
    const harness = createHarness({ rows: [stalePending] });

    const result = await harness.materializer.processPendingSelections();

    expect(result).toMatchObject({ processed: 1, materialized: 0, stale: 1 });
    expect(harness.connection.beginTransaction).not.toHaveBeenCalled();
  });

  it("keeps the task waiting and records an error when materialization fails", async () => {
    const harness = createHarness({
      generatorError: new Error("Bedrock unavailable"),
    });

    const result = await harness.materializer.processPendingSelections();

    expect(result).toMatchObject({ processed: 1, materialized: 0, failed: 1 });
    expect(harness.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("retry_count = retry_count + 1"),
      ["Bedrock unavailable", 1234],
    );
    expect(harness.connection.beginTransaction).not.toHaveBeenCalled();
  });
});
