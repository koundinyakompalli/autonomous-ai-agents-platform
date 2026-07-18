import { beforeEach, describe, expect, it, vi } from "vitest";

const getConnectionMock = vi.fn();
const { sqsSendMock, sendMessageCommandInputs } = vi.hoisted(() => ({
  sqsSendMock: vi.fn(),
  sendMessageCommandInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db.js", () => ({
  getPool: () => ({
    getConnection: getConnectionMock,
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

const operator = {
  id: "rmadhukar",
  display: "R Madhukar",
};

type RetryRunFixture = {
  id: number;
  jira_key: string;
  state: string;
  final_disposition: string | null;
  last_error: string | null;
  current_plan_version: number | null;
  current_review_version: number | null;
  current_implementation_version: number | null;
  current_implementation_branch: string | null;
  current_implementation_commit_sha: string | null;
  current_code_review_version: number | null;
  current_test_version: number | null;
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
  return import("./oneshotRunRetries.js");
}

function failedImplementationRun(overrides: Partial<RetryRunFixture> = {}): RetryRunFixture {
  return {
    id: 86,
    jira_key: "CPDEV-86",
    state: "failed",
    final_disposition: "budget_exceeded",
    last_error: "OneShot implementer stage_budget_exceeded",
    current_plan_version: 1,
    current_review_version: 1,
    current_implementation_version: 1,
    current_implementation_branch: null,
    current_implementation_commit_sha: null,
    current_code_review_version: null,
    current_test_version: null,
    ...overrides,
  };
}

function failedReviewRun(): RetryRunFixture {
  return {
    id: 86,
    jira_key: "CPDEV-86",
    state: "failed",
    final_disposition: "review_rejected",
    last_error: "OneShot reviewer rejected the plan",
    current_plan_version: 1,
    current_review_version: 1,
    current_implementation_version: null,
    current_implementation_branch: null,
    current_implementation_commit_sha: null,
    current_code_review_version: null,
    current_test_version: null,
  };
}

describe("oneshotRunRetries", () => {
  beforeEach(() => {
    getConnectionMock.mockReset();
    sqsSendMock.mockReset();
    sqsSendMock.mockResolvedValue({});
    sendMessageCommandInputs.length = 0;
    delete process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL;
    delete process.env.ONESHOT_REVIEW_QUEUE_URL;
  });

  it("queues first manual implementation retry as a base pass when no prior implementation output exists", async () => {
    const connection = createConnection(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM oneshot_runs") && sql.includes("FOR UPDATE")) {
        expect(params).toEqual([86]);
        return [[failedImplementationRun()]];
      }

      if (sql.includes("COALESCE(stage, from_state)")) {
        return [[{ stage: "implementation" }]];
      }

      if (sql.includes("FROM oneshot_artifacts")) {
        return [[]];
      }

      if (sql.includes("COUNT(*) AS retry_count")) {
        expect(params).toEqual([86, "implementation"]);
        return [[{ retry_count: 0 }]];
      }

      if (sql.includes("UPDATE oneshot_runs")) {
        expect(sql).not.toContain("current_implementation_branch");
        expect(params).toEqual([
          "queued_for_implementation",
          0,
          2,
          null,
          86,
        ]);
        return [{ affectedRows: 1 }];
      }

      if (sql.includes("INSERT INTO oneshot_run_events")) {
        expect(params?.slice(0, 5)).toEqual([
          86,
          "state_transition",
          "failed",
          "queued_for_implementation",
          "implementation",
        ]);
        expect(String(params?.[5])).toContain('"reason":"manual_stage_retry"');
        expect(String(params?.[5])).toContain('"attemptNumber":1');
        expect(String(params?.[5])).toContain('"revision":false');
        return [{ insertId: 1 }];
      }

      throw new Error(`Unexpected query: ${sql}`);
    });
    getConnectionMock.mockResolvedValue(connection);
    const publish = vi.fn().mockResolvedValue(undefined);

    const { retryOneShotRunStage } = await loadModule();

    await expect(
      retryOneShotRunStage(
        { dashboardId: "run-86", operator },
        { publish },
      ),
    ).resolves.toEqual({
      oneshotRunId: 86,
      stage: "implementation",
      state: "queued_for_implementation",
      version: 2,
      attemptsUsed: 1,
      attemptsRemaining: 1,
      publishError: undefined,
    });

    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      86,
      expect.objectContaining({
        stage: "implementation",
        version: 2,
        revision: false,
        manualRetryDedupeToken: "manual-retry:1",
      }),
    );
  });

  it("queues manual implementation retry as a revision only when prior implementation output exists", async () => {
    const connection = createConnection(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM oneshot_runs") && sql.includes("FOR UPDATE")) {
        expect(params).toEqual([86]);
        return [[failedImplementationRun({
          current_implementation_branch: "oneshot/cpdev-86-run-86",
          current_implementation_commit_sha: "abc123",
        })]];
      }

      if (sql.includes("COALESCE(stage, from_state)")) {
        return [[{ stage: "implementation" }]];
      }

      if (sql.includes("FROM oneshot_artifacts")) {
        return [[]];
      }

      if (sql.includes("COUNT(*) AS retry_count")) {
        expect(params).toEqual([86, "implementation"]);
        return [[{ retry_count: 0 }]];
      }

      if (sql.includes("UPDATE oneshot_runs")) {
        expect(sql).not.toContain("current_implementation_branch");
        return [{ affectedRows: 1 }];
      }

      if (sql.includes("INSERT INTO oneshot_run_events")) {
        expect(String(params?.[5])).toContain('"revision":true');
        return [{ insertId: 2 }];
      }

      throw new Error(`Unexpected query: ${sql}`);
    });
    getConnectionMock.mockResolvedValue(connection);
    const publish = vi.fn().mockResolvedValue(undefined);

    const { retryOneShotRunStage } = await loadModule();

    await expect(
      retryOneShotRunStage(
        { dashboardId: "run-86", operator },
        { publish },
      ),
    ).resolves.toMatchObject({
      stage: "implementation",
      version: 2,
    });

    expect(publish).toHaveBeenCalledWith(
      86,
      expect.objectContaining({
        stage: "implementation",
        version: 2,
        revision: true,
        manualRetryDedupeToken: "manual-retry:2",
      }),
    );
  });

  it("includes the manual retry event id in the FIFO dedupe id", async () => {
    process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL = "https://sqs.example/implementation.fifo";
    const connection = createConnection(async (sql: string) => {
      if (sql.includes("FROM oneshot_runs") && sql.includes("FOR UPDATE")) {
        return [[failedImplementationRun()]];
      }
      if (sql.includes("COALESCE(stage, from_state)")) {
        return [[{ stage: "implementation" }]];
      }
      if (sql.includes("FROM oneshot_artifacts")) {
        return [[]];
      }
      if (sql.includes("COUNT(*) AS retry_count")) {
        return [[{ retry_count: 0 }]];
      }
      if (sql.includes("UPDATE oneshot_runs")) {
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("INSERT INTO oneshot_run_events")) {
        return [{ insertId: 17 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    getConnectionMock.mockResolvedValue(connection);

    const { retryOneShotRunStage } = await loadModule();

    await retryOneShotRunStage({ dashboardId: "run-86", operator });

    expect(sendMessageCommandInputs).toHaveLength(1);
    expect(sendMessageCommandInputs[0]).toMatchObject({
      QueueUrl: "https://sqs.example/implementation.fifo",
      MessageDeduplicationId: "86:implementation:2:base:manual-retry:17",
    });
  });

  it("uses a different FIFO dedupe id for repeated same-version review retries", async () => {
    process.env.ONESHOT_REVIEW_QUEUE_URL = "https://sqs.example/review.fifo";
    const createReviewConnection = (retryCount: number, eventId: number) =>
      createConnection(async (sql: string) => {
        if (sql.includes("FROM oneshot_runs") && sql.includes("FOR UPDATE")) {
          return [[failedReviewRun()]];
        }
        if (sql.includes("COALESCE(stage, from_state)")) {
          return [[{ stage: "review" }]];
        }
        if (sql.includes("FROM oneshot_artifacts")) {
          return [[]];
        }
        if (sql.includes("COUNT(*) AS retry_count")) {
          return [[{ retry_count: retryCount }]];
        }
        if (sql.includes("UPDATE oneshot_runs")) {
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("INSERT INTO oneshot_run_events")) {
          return [{ insertId: eventId }];
        }
        throw new Error(`Unexpected query: ${sql}`);
      });
    getConnectionMock
      .mockResolvedValueOnce(createReviewConnection(0, 21))
      .mockResolvedValueOnce(createReviewConnection(1, 22));

    const { retryOneShotRunStage } = await loadModule();

    await retryOneShotRunStage({ dashboardId: "run-86", operator });
    await retryOneShotRunStage({ dashboardId: "run-86", operator });

    expect(sendMessageCommandInputs.map(input => input.MessageDeduplicationId)).toEqual([
      "86:review:1:base:manual-retry:21",
      "86:review:1:base:manual-retry:22",
    ]);
  });

  it("rejects exhausted manual retry caps per stage", async () => {
    const connection = createConnection(async (sql: string) => {
      if (sql.includes("FROM oneshot_runs") && sql.includes("FOR UPDATE")) {
        return [[failedImplementationRun()]];
      }
      if (sql.includes("COALESCE(stage, from_state)")) {
        return [[{ stage: "implementation" }]];
      }
      if (sql.includes("FROM oneshot_artifacts")) {
        return [[]];
      }
      if (sql.includes("COUNT(*) AS retry_count")) {
        return [[{ retry_count: 2 }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    getConnectionMock.mockResolvedValue(connection);
    const publish = vi.fn();

    const { retryOneShotRunStage, OneShotRunRetryError } = await loadModule();

    await expect(
      retryOneShotRunStage(
        { dashboardId: "run-86", operator },
        { publish },
      ),
    ).rejects.toMatchObject<Partial<InstanceType<typeof OneShotRunRetryError>>>({
      statusCode: 409,
    });

    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns publishError after committing the queued retry", async () => {
    const connection = createConnection(async (sql: string) => {
      if (sql.includes("FROM oneshot_runs") && sql.includes("FOR UPDATE")) {
        return [[failedImplementationRun()]];
      }
      if (sql.includes("COALESCE(stage, from_state)")) {
        return [[{ stage: "implementation" }]];
      }
      if (sql.includes("FROM oneshot_artifacts")) {
        return [[]];
      }
      if (sql.includes("COUNT(*) AS retry_count")) {
        return [[{ retry_count: 1 }]];
      }
      if (sql.includes("UPDATE oneshot_runs")) {
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("INSERT INTO oneshot_run_events")) {
        return [{ insertId: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    getConnectionMock.mockResolvedValue(connection);
    const publish = vi.fn().mockRejectedValue(new Error("sqs unavailable"));

    const { retryOneShotRunStage } = await loadModule();

    await expect(
      retryOneShotRunStage(
        { dashboardId: "run-86", operator },
        { publish },
      ),
    ).resolves.toMatchObject({
      attemptsUsed: 2,
      attemptsRemaining: 0,
      publishError: "sqs unavailable",
    });

    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
  });
});
