import { beforeEach, describe, expect, it, vi } from "vitest";

const getConnectionMock = vi.fn();
const poolQueryMock = vi.fn();
const { sqsSendMock, sendMessageCommandInputs } = vi.hoisted(() => ({
  sqsSendMock: vi.fn(),
  sendMessageCommandInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db.js", () => ({
  getPool: () => ({
    getConnection: getConnectionMock,
    query: poolQueryMock,
  }),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn(function SQSClient() {
    return {
    send: sqsSendMock,
    };
  }),
  SendMessageCommand: vi.fn(function SendMessageCommand(input: Record<string, unknown>) {
    sendMessageCommandInputs.push(input);
    return { input };
  }),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn(),
  })),
  DeleteObjectsCommand: vi.fn().mockImplementation((input: Record<string, unknown>) => ({
    input,
  })),
  ListObjectsV2Command: vi.fn().mockImplementation((input: Record<string, unknown>) => ({
    input,
  })),
}));

const operator = {
  id: "rmadhukar",
  display: "R Madhukar",
};

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

async function loadModule() {
  vi.resetModules();
  return import("./oneshotRunControls.js");
}

describe("oneshotRunControls", () => {
  beforeEach(() => {
    getConnectionMock.mockReset();
    poolQueryMock.mockReset();
    sqsSendMock.mockReset();
    sqsSendMock.mockResolvedValue({});
    sendMessageCommandInputs.length = 0;
    delete process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL;
    delete process.env.ONESHOT_ARTIFACT_BUCKET;
    delete process.env.ONESHOT_ARTIFACT_PREFIX;
  });

  it("restarts an active implementation run using normal per-run FIFO dispatch", async () => {
    process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL =
      "https://sqs.example/implementation.fifo";
    const connection = createConnection(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM oneshot_runs") && sql.includes("FOR UPDATE")) {
        expect(params).toEqual([86]);
        return [[
          {
            id: 86,
            jira_key: "CPDEV-86",
            state: "implementing",
            run_group_id: null,
            source_task_management_id: 501,
            final_disposition: null,
            last_error: "prior timeout",
            current_plan_version: 2,
            current_review_version: 2,
            current_implementation_version: 2,
            current_implementation_branch: "oneshot/cpdev-86-run-86",
            current_implementation_commit_sha: "abc123",
            current_code_review_version: 1,
            current_test_version: null,
          },
        ]];
      }

      if (sql.includes("UPDATE oneshot_runs")) {
        expect(sql).not.toContain("current_implementation_branch");
        expect(params).toEqual([
          "queued_for_implementation",
          3,
          0,
          0,
          0,
          null,
          2,
          86,
          "implementing",
        ]);
        return [{ affectedRows: 1 }];
      }

      if (sql.includes("INSERT INTO oneshot_run_events")) {
        expect(params?.slice(0, 5)).toEqual([
          86,
          "state_transition",
          "implementing",
          "queued_for_implementation",
          "implementation",
        ]);
        expect(String(params?.[5])).toContain('"reason":"manual_stage_restart"');
        expect(String(params?.[5])).toContain('"dispatchMode":"safe_fifo"');
        expect(String(params?.[5])).toContain('"current_code_review_version"');
        return [{ insertId: 42 }];
      }

      throw new Error(`Unexpected query: ${sql}`);
    });
    getConnectionMock.mockResolvedValue(connection);

    const { restartOneShotRunStage } = await loadModule();

    await expect(
      restartOneShotRunStage({
        dashboardId: "run-86",
        stage: "implementation",
        operator,
        reason: "try again",
      }),
    ).resolves.toEqual({
      oneshotRunId: 86,
      stage: "implementation",
      state: "queued_for_implementation",
      version: 3,
      publishError: undefined,
    });

    expect(sendMessageCommandInputs).toHaveLength(1);
    expect(sendMessageCommandInputs[0]).toMatchObject({
      QueueUrl: "https://sqs.example/implementation.fifo",
      MessageGroupId: "86",
      MessageDeduplicationId:
        "86:implementation:3:revision:manual-restart:42",
    });
    expect(JSON.parse(String(sendMessageCommandInputs[0].MessageBody))).toMatchObject({
      run_id: 86,
      stage: "implementation",
      version: 3,
      expected_state: "queued_for_implementation",
      revision: true,
    });
  });

  it("aborts hard delete before DB mutation when S3 purge fails", async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM oneshot_runs") && sql.includes("LIMIT 1")) {
        return [[
          {
            id: 86,
            jira_key: "CPDEV-86",
            run_group_id: null,
            source_task_management_id: 501,
          },
        ]];
      }
      if (sql.includes("FROM oneshot_runs") && sql.includes("ORDER BY id")) {
        return [[
          {
            id: 86,
            jira_key: "CPDEV-86",
            run_group_id: null,
            source_task_management_id: 501,
          },
        ]];
      }
      if (sql.includes("FROM oneshot_run_groups")) return [[]];
      if (sql.includes("FROM oneshot_artifacts")) {
        return [[
          {
            oneshot_run_id: 86,
            s3_bucket: "specter-results",
            s3_key: "oneshot/CPDEV-86/run-86/plans/v1/plan.json",
          },
        ]];
      }
      if (sql.includes("FROM task_management")) {
        return [[{
          id: 501,
          task_id: 701,
          task_s3_bucket: "specter-results",
          task_s3_key: "tasks/CPDEV-86.md",
        }]];
      }
      if (sql.includes("FROM tasks")) {
        return [[{
          id: 701,
          result_s3_bucket: "specter-results",
          result_s3_key: "results/CPDEV-86.md",
        }]];
      }
      if (sql.includes("FROM oneshot_deployments")) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const purgeS3 = vi.fn().mockRejectedValue(new Error("s3 denied"));

    const { hardDeleteOneShotRun, OneShotRunControlError } = await loadModule();

    await expect(
      hardDeleteOneShotRun(
        {
          dashboardId: "run-86",
          confirmDashboardId: "run-86",
          operator,
        },
        { purgeS3 },
      ),
    ).rejects.toMatchObject<Partial<InstanceType<typeof OneShotRunControlError>>>({
      statusCode: 502,
    });

    expect(purgeS3).toHaveBeenCalledWith({
      objects: [
        {
          bucket: "specter-results",
          key: "oneshot/CPDEV-86/run-86/plans/v1/plan.json",
        },
        {
          bucket: "specter-results",
          key: "tasks/CPDEV-86.md",
        },
        {
          bucket: "specter-results",
          key: "results/CPDEV-86.md",
        },
      ],
      prefixes: [
        {
          bucket: "specter-results",
          prefix: "oneshot/CPDEV-86/run-86/",
        },
      ],
    });
    expect(getConnectionMock).not.toHaveBeenCalled();
  });

  it("hard deletes sibling runs, source task links, and child rows after S3 purge", async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM oneshot_runs") && sql.includes("LIMIT 1")) {
        return [[
          {
            id: 86,
            jira_key: "CPDEV-86",
            run_group_id: 9001,
            source_task_management_id: 501,
          },
        ]];
      }
      if (sql.includes("FROM oneshot_runs") && sql.includes("ORDER BY id")) {
        return [[
          {
            id: 86,
            jira_key: "CPDEV-86",
            run_group_id: 9001,
            source_task_management_id: 501,
          },
          {
            id: 87,
            jira_key: "CPDEV-86",
            run_group_id: 9001,
            source_task_management_id: 501,
          },
        ]];
      }
      if (sql.includes("FROM oneshot_run_groups")) {
        return [[{ id: 9001, source_task_management_id: 501 }]];
      }
      if (sql.includes("FROM oneshot_artifacts")) {
        return [[
          {
            oneshot_run_id: 86,
            s3_bucket: "specter-results",
            s3_key: "oneshot/CPDEV-86/run-86/plans/v1/plan.json",
          },
          {
            oneshot_run_id: 87,
            s3_bucket: "specter-results",
            s3_key: "oneshot/CPDEV-86/run-87/plans/v1/plan.json",
          },
        ]];
      }
      if (sql.includes("FROM task_management")) {
        return [[{
          id: 501,
          task_id: 701,
          task_s3_bucket: null,
          task_s3_key: null,
        }]];
      }
      if (sql.includes("FROM tasks")) {
        return [[{
          id: 701,
          result_s3_bucket: null,
          result_s3_key: null,
        }]];
      }
      if (sql.includes("FROM oneshot_deployments")) {
        return [[{ id: 301 }, { id: 302 }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
	    const deleteOrder: string[] = [];
	    const connection = createConnection(async (sql: string) => {
	      if (sql.includes("chat_sessions")) deleteOrder.push("chat_sessions");
	      if (
	        sql.includes("UPDATE watchdog_darci_handoffs") &&
	        sql.includes("task_management_id = NULL")
	      ) {
	        deleteOrder.push("watchdog_darci_handoffs_task_management");
	      }
	      if (
	        sql.includes("UPDATE watchdog_darci_handoffs") &&
	        sql.includes("task_id = NULL")
	      ) {
	        deleteOrder.push("watchdog_darci_handoffs_task_id");
	      }
	      if (sql.includes("router_confirmations")) {
	        deleteOrder.push("router_confirmations");
      }
      if (sql.includes("router_decisions")) deleteOrder.push("router_decisions");
      if (sql.includes("oneshot_dashboard_run_requests")) {
        deleteOrder.push("oneshot_dashboard_run_requests");
        throw Object.assign(new Error("missing dashboard request table"), {
          code: "ER_NO_SUCH_TABLE",
        });
      }
      if (sql.includes("UPDATE oneshot_deployments")) {
        deleteOrder.push("oneshot_deployments_refs");
      }
	      if (sql.includes("DELETE FROM oneshot_deployments")) {
	        deleteOrder.push("oneshot_deployments");
	      }
	      if (sql.includes("DELETE FROM oneshot_workspace_state")) {
	        deleteOrder.push("oneshot_workspace_state");
	        throw Object.assign(new Error("missing optional table"), {
	          code: "ER_NO_SUCH_TABLE",
	        });
	      }
	      if (sql.includes("DELETE FROM oneshot_runs")) {
	        deleteOrder.push("oneshot_runs");
	      }
      if (sql.includes("DELETE FROM oneshot_run_groups")) {
        deleteOrder.push("oneshot_run_groups");
      }
      if (sql.includes("DELETE FROM task_management")) {
        deleteOrder.push("task_management");
      }
      if (sql.includes("DELETE FROM tasks")) deleteOrder.push("tasks");
      return [{ affectedRows: 1 }];
    });
    getConnectionMock.mockResolvedValue(connection);
    const purgeS3 = vi.fn().mockResolvedValue({
      deletedObjects: 2,
      objects: [],
      prefixes: [],
    });

    const { hardDeleteOneShotRun } = await loadModule();

    await expect(
      hardDeleteOneShotRun(
        {
          dashboardId: "run-86",
          confirmDashboardId: "run-86",
          operator,
          reason: "cleanup failed experiment",
        },
        { purgeS3 },
      ),
	    ).resolves.toMatchObject({
	      deleted: true,
	      affectedRunIds: [86, 87],
	      sourceTaskManagementIds: [501],
	      deletedCounts: {
	        oneshot_dashboard_run_requests: 0,
	        oneshot_workspace_state: 0,
	        watchdog_darci_handoffs_task_management_cleared: 1,
	        watchdog_darci_handoffs_task_id_cleared: 1,
	      },
	      s3DeletedObjects: 2,
	    });

    expect(deleteOrder.indexOf("oneshot_deployments")).toBeLessThan(
      deleteOrder.indexOf("oneshot_runs"),
    );
    expect(deleteOrder.indexOf("oneshot_runs")).toBeLessThan(
      deleteOrder.indexOf("oneshot_run_groups"),
    );
	    expect(deleteOrder.indexOf("oneshot_run_groups")).toBeLessThan(
	      deleteOrder.indexOf("task_management"),
	    );
	    expect(deleteOrder.indexOf("watchdog_darci_handoffs_task_id")).toBeLessThan(
	      deleteOrder.indexOf("tasks"),
	    );
	    expect(deleteOrder).toContain("oneshot_workspace_state");
	    expect(deleteOrder.indexOf("task_management")).toBeLessThan(
	      deleteOrder.indexOf("tasks"),
	    );
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
  });
});
