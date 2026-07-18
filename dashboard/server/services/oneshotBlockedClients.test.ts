import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deactivateBlockedClient,
  listBlockedClients,
  reactivateBlockedClient,
  upsertBlockedClient,
} from "./oneshotBlockedClients.js";

function createConnection(rowsByQuery: unknown[][] = []) {
  let rowIndex = 0;
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (/^SELECT/i.test(sql.trim())) {
        return Promise.resolve([rowsByQuery[rowIndex++] ?? []]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    }),
  };
  return { connection, queries };
}

describe("oneshotBlockedClients service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists only active clients by default", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue([
        [
          {
            client_key: "blocked corp",
            display_name: "Blocked Corp",
            reason: "Contract exclusion",
            is_active: 1,
            created_by: "rmadhukar",
            created_by_display: "R Madhukar",
            updated_by: "rmadhukar",
            updated_by_display: "R Madhukar",
            created_at: new Date("2026-06-16T10:00:00.000Z"),
            updated_at: new Date("2026-06-16T11:00:00.000Z"),
          },
        ],
      ]),
    };

    await expect(listBlockedClients({ includeInactive: false }, pool as never))
      .resolves.toEqual([
        expect.objectContaining({
          clientKey: "blocked corp",
          displayName: "Blocked Corp",
          isActive: true,
        }),
      ]);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE is_active = TRUE"),
    );
  });

  it("creates a blocked client and writes an audit event", async () => {
    const { connection, queries } = createConnection([
      [],
      [
        {
          client_key: "blocked corp",
          display_name: "Blocked Corp",
          reason: "Contract exclusion",
          is_active: 1,
          created_by: "rmadhukar",
          created_by_display: "R Madhukar",
          updated_by: "rmadhukar",
          updated_by_display: "R Madhukar",
          created_at: "2026-06-16T10:00:00.000Z",
          updated_at: "2026-06-16T10:00:00.000Z",
        },
      ],
    ]);
    const pool = { getConnection: vi.fn().mockResolvedValue(connection) };

    await expect(
      upsertBlockedClient(
        {
          displayName: " Blocked   Corp ",
          reason: "Contract exclusion",
          operator: { id: "rmadhukar", display: "R Madhukar" },
        },
        pool as never,
      ),
    ).resolves.toMatchObject({
      action: "created",
      client: {
        clientKey: "blocked corp",
        displayName: "Blocked Corp",
      },
    });

    expect(connection.beginTransaction).toHaveBeenCalled();
    expect(connection.commit).toHaveBeenCalled();
    expect(
      queries.some((entry) =>
        entry.sql.includes("INSERT INTO oneshot_blocked_client_audit_events") &&
        entry.params?.includes("created"),
      ),
    ).toBe(true);
  });

  it("deactivates and reactivates a client with audit events", async () => {
    const existing = {
      client_key: "blocked corp",
      display_name: "Blocked Corp",
      reason: "Contract exclusion",
      is_active: 1,
      created_by: "rmadhukar",
      created_by_display: "R Madhukar",
      updated_by: "rmadhukar",
      updated_by_display: "R Madhukar",
      created_at: "2026-06-16T10:00:00.000Z",
      updated_at: "2026-06-16T10:00:00.000Z",
    };
    const deactivated = { ...existing, is_active: 0 };
    const reactivated = { ...existing, is_active: 1 };

    const deactivateConnection = createConnection([[existing], [deactivated]]);
    await deactivateBlockedClient(
      {
        clientKey: "blocked corp",
        reason: "Temporary exclusion complete",
        operator: { id: "rmadhukar", display: "R Madhukar" },
      },
      { getConnection: vi.fn().mockResolvedValue(deactivateConnection.connection) } as never,
    );

    expect(
      deactivateConnection.queries.some((entry) =>
        entry.sql.includes("INSERT INTO oneshot_blocked_client_audit_events") &&
        entry.params?.includes("deactivated"),
      ),
    ).toBe(true);

    const reactivateConnection = createConnection([[deactivated], [reactivated]]);
    await reactivateBlockedClient(
      {
        clientKey: "blocked corp",
        reason: "Reinstated exclusion",
        operator: { id: "rmadhukar", display: "R Madhukar" },
      },
      { getConnection: vi.fn().mockResolvedValue(reactivateConnection.connection) } as never,
    );

    expect(
      reactivateConnection.queries.some((entry) =>
        entry.sql.includes("INSERT INTO oneshot_blocked_client_audit_events") &&
        entry.params?.includes("reactivated"),
      ),
    ).toBe(true);
  });

  it("maps missing policy tables to policy_store_unavailable", async () => {
    const error = Object.assign(new Error("No table"), {
      code: "ER_NO_SUCH_TABLE",
    });
    const pool = { query: vi.fn().mockRejectedValue(error) };

    await expect(listBlockedClients({ includeInactive: true }, pool as never))
      .rejects.toMatchObject({
        statusCode: 503,
        code: "policy_store_unavailable",
      });
  });

  it("maps mutation connection failures to policy_store_unavailable", async () => {
    const error = Object.assign(new Error("DB unavailable"), {
      code: "ECONNREFUSED",
    });
    const pool = { getConnection: vi.fn().mockRejectedValue(error) };

    await expect(
      upsertBlockedClient(
        {
          displayName: "Blocked Corp",
          reason: "Contract exclusion",
          operator: { id: "rmadhukar", display: "R Madhukar" },
        },
        pool as never,
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "policy_store_unavailable",
    });
  });
});
