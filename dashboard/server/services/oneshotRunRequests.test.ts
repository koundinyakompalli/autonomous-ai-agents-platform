import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../db.js", () => ({
  getPool: () => ({
    query: queryMock,
  }),
}));

const operator = {
  id: "rmadhukar",
  display: "R Madhukar",
};

async function loadModule() {
  vi.resetModules();
  return import("./oneshotRunRequests.js");
}

describe("oneshotRunRequests", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("rejects malformed Jira keys", async () => {
    const { createOneShotRunRequest } = await loadModule();

    queryMock.mockResolvedValueOnce([[{ table_name: "oneshot_dashboard_run_requests" }]]);

    await expect(
      createOneShotRunRequest({
        jiraKey: "not-a-ticket",
        operator,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "jiraKey must look like ABC-123",
    });
  });

  it("rejects fresh-run submissions when a OneShot run already exists", async () => {
    const { createOneShotRunRequest } = await loadModule();

    queryMock.mockResolvedValueOnce([[{ table_name: "oneshot_dashboard_run_requests" }]]);
    queryMock.mockResolvedValueOnce([[{ id: 9 }]]);
    queryMock.mockResolvedValueOnce([[{ id: 44 }]]);

    await expect(
      createOneShotRunRequest({
        jiraKey: "CPDEV-123",
        operator,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("creates a queued durable run request", async () => {
    const { createOneShotRunRequest } = await loadModule();
    const createdAt = new Date("2026-04-19T12:00:00Z");

    queryMock.mockResolvedValueOnce([[{ table_name: "oneshot_dashboard_run_requests" }]]);
    queryMock.mockResolvedValueOnce([[{ id: 9 }]]);
    queryMock.mockResolvedValueOnce([[]]);
    queryMock.mockResolvedValueOnce([[]]);
    queryMock.mockResolvedValueOnce([{ insertId: 42 }]);
    queryMock.mockResolvedValueOnce([[
      {
        id: 42,
        jira_key: "CPDEV-123",
        requested_by: operator.id,
        requested_by_display: operator.display,
        status: "queued",
        error_message: null,
        task_management_id: null,
        created_at: createdAt,
        updated_at: createdAt,
        started_at: null,
        finished_at: null,
      },
    ]]);

    await expect(
      createOneShotRunRequest({
        jiraKey: "cpdev-123",
        operator,
      }),
    ).resolves.toEqual({
      id: 42,
      jiraKey: "CPDEV-123",
      status: "queued",
      submittedAt: createdAt.toISOString(),
    });
  });

  it("resolves a dashboard id from task_management linkage", async () => {
    const { getOneShotRunRequestById } = await loadModule();
    const createdAt = new Date("2026-04-19T12:00:00Z");

    queryMock.mockResolvedValueOnce([[{ table_name: "oneshot_dashboard_run_requests" }]]);
    queryMock.mockResolvedValueOnce([[
      {
        id: 7,
        jira_key: "CPDEV-777",
        requested_by: operator.id,
        requested_by_display: operator.display,
        status: "task_created",
        error_message: null,
        task_management_id: 55,
        created_at: createdAt,
        updated_at: createdAt,
        started_at: createdAt,
        finished_at: createdAt,
      },
    ]]);
    queryMock.mockResolvedValueOnce([[{ id: 901 }]]);

    await expect(getOneShotRunRequestById(7)).resolves.toEqual({
      id: 7,
      jiraKey: "CPDEV-777",
      status: "task_created",
      submittedAt: createdAt.toISOString(),
      error: null,
      taskManagementId: 55,
      dashboardId: "run-901",
      startedAt: createdAt.toISOString(),
      finishedAt: createdAt.toISOString(),
    });
  });
});
