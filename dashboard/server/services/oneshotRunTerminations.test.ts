import { beforeEach, describe, expect, it, vi } from "vitest";

const getConnectionMock = vi.fn();

vi.mock("../db.js", () => ({
  getPool: () => ({
    getConnection: getConnectionMock,
  }),
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
  return import("./oneshotRunTerminations.js");
}

describe("oneshotRunTerminations", () => {
  beforeEach(() => {
    getConnectionMock.mockReset();
    vi.restoreAllMocks();
  });

  it("rejects terminal runs with 409", async () => {
    const connection = createConnection(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id, jira_key, state, final_disposition")) {
        return [
          [
            {
              id: 91,
              jira_key: "CPDEV-91",
              state: "failed",
              final_disposition: "run_failed",
            },
          ],
        ];
      }

      throw new Error(`Unexpected query: ${sql}`);
    });
    getConnectionMock.mockResolvedValue(connection);

    const { terminateOneShotRun, OneShotRunTerminationError } =
      await loadModule();

    await expect(
      terminateOneShotRun({
        oneshotRunId: 91,
        operator,
      }),
    ).rejects.toMatchObject<
      Partial<InstanceType<typeof OneShotRunTerminationError>>
    >({
      statusCode: 409,
    });
  });

  it("stores operator identity and optional reason in failure metadata and notification text", async () => {
    const connection = createConnection(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT id, jira_key, state, final_disposition")) {
          expect(params).toEqual([91]);
          return [
            [
              {
                id: 91,
                jira_key: "CPDEV-91",
                state: "reviewing",
                final_disposition: null,
              },
            ],
          ];
        }

        if (sql.includes("UPDATE oneshot_runs")) {
          expect(params).toEqual([
            "OneShot run terminated by R Madhukar (rmadhukar). Reason: free the slot",
            91,
            "reviewing",
          ]);
          return [{ affectedRows: 1 }];
        }

        if (sql.includes("INSERT INTO oneshot_run_events")) {
          if (params?.[1] === "state_transition") {
            expect(params?.slice(0, 5)).toEqual([
              91,
              "state_transition",
              "reviewing",
              "failed",
              "review",
            ]);
          } else {
            expect(params?.slice(0, 5)).toEqual([
              91,
              "workspace_cleanup_requested",
              null,
              null,
              "review",
            ]);
          }
          expect(String(params?.[5])).toContain('"reason":"operator_kill"');
          expect(String(params?.[5])).toContain('"operatorId":"rmadhukar"');
          expect(String(params?.[5])).toContain(
            '"operatorDisplay":"R Madhukar"',
          );
          expect(String(params?.[5])).toContain(
            '"operatorReason":"free the slot"',
          );
          return [{ insertId: 1 }];
        }

        if (sql.includes("INSERT INTO oneshot_notifications")) {
          expect(params?.slice(0, 3)).toEqual([91, "CPDEV-91", "run_failed"]);
          expect(String(params?.[3])).toContain(
            "Run terminated by R Madhukar (rmadhukar).",
          );
          expect(String(params?.[3])).toContain(
            "Operator reason: free the slot",
          );
          return [{ insertId: 2 }];
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    );
    getConnectionMock.mockResolvedValue(connection);

    const { terminateOneShotRun } = await loadModule();

    await expect(
      terminateOneShotRun({
        oneshotRunId: 91,
        operator,
        reason: "free the slot",
      }),
    ).resolves.toEqual({
      oneshotRunId: 91,
      workspaceCleanupStatus: "requested",
      workspaceCleanupSucceeded: true,
    });
  });

  it("requests async workspace cleanup in the same DB transition", async () => {
    const eventTypes: unknown[] = [];
    const connection = createConnection(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id, jira_key, state, final_disposition")) {
        return [
          [
            {
              id: 92,
              jira_key: "CPDEV-92",
              state: "queued_for_testing",
              final_disposition: null,
            },
          ],
        ];
      }

      if (sql.includes("UPDATE oneshot_runs")) {
        return [{ affectedRows: 1 }];
      }

      if (sql.includes("INSERT INTO oneshot_run_events")) {
        eventTypes.push(params?.[1]);
        return [{ insertId: 1 }];
      }

      if (sql.includes("INSERT INTO oneshot_notifications")) {
        return [{ insertId: 2 }];
      }

      throw new Error(`Unexpected query: ${sql}`);
    });
    getConnectionMock.mockResolvedValue(connection);

    const { terminateOneShotRun } = await loadModule();

    await expect(
      terminateOneShotRun({
        oneshotRunId: 92,
        operator,
      }),
    ).resolves.toEqual({
      oneshotRunId: 92,
      workspaceCleanupStatus: "requested",
      workspaceCleanupSucceeded: true,
    });
    expect(eventTypes).toEqual([
      "state_transition",
      "workspace_cleanup_requested",
    ]);
  });
});
