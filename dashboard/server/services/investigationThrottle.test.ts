import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => {
  type Slot = { runId: string | null; leaseExpiresAt: number | null };
  const slots = new Map<string, Map<number, Slot>>();
  const pool = {
    execute: vi.fn(),
  };
  return { pool, slots };
});

vi.mock("../db.js", () => ({
  getPool: () => mockDb.pool,
}));

function slotMap(targetKey: string): Map<number, { runId: string | null; leaseExpiresAt: number | null }> {
  const existing = mockDb.slots.get(targetKey);
  if (existing) {
    return existing;
  }
  const created = new Map<number, { runId: string | null; leaseExpiresAt: number | null }>();
  mockDb.slots.set(targetKey, created);
  return created;
}

function installFakeMysqlSlotStore() {
  mockDb.pool.execute.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("INSERT IGNORE INTO investigation_target_slots")) {
      const [targetKey, slotNo] = params as [string, number];
      const slots = slotMap(targetKey);
      if (!slots.has(slotNo)) {
        slots.set(slotNo, { runId: null, leaseExpiresAt: null });
      }
      return [{ affectedRows: 1 }, []];
    }

    if (sql.includes("SET run_id = ?") && sql.includes("ORDER BY slot_no")) {
      const [runId, leaseSeconds, targetKey, maxConcurrent] = params as [string, number, string, number];
      const slots = slotMap(targetKey);
      const now = Date.now();
      for (let slotNo = 1; slotNo <= maxConcurrent; slotNo += 1) {
        const slot = slots.get(slotNo);
        if (slot && (!slot.runId || (slot.leaseExpiresAt ?? 0) < now)) {
          slot.runId = runId;
          slot.leaseExpiresAt = now + leaseSeconds * 1000;
          return [{ affectedRows: 1 }, []];
        }
      }
      return [{ affectedRows: 0 }, []];
    }

    if (sql.includes("SELECT slot_no")) {
      const [targetKey, runId] = params as [string, string];
      const slots = slotMap(targetKey);
      for (const [slotNo, slot] of slots.entries()) {
        if (slot.runId === runId) {
          return [[{ slot_no: slotNo }], []];
        }
      }
      return [[], []];
    }

    if (sql.includes("SET lease_expires_at = DATE_ADD")) {
      return [{ affectedRows: 1 }, []];
    }

    if (sql.includes("SET run_id = NULL")) {
      const [targetKey, slotNo, runId] = params as [string, number, string];
      const slot = slotMap(targetKey).get(slotNo);
      if (slot?.runId === runId) {
        slot.runId = null;
        slot.leaseExpiresAt = null;
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 0 }, []];
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

async function loadThrottleModule() {
  vi.resetModules();
  return import("./investigationThrottle.js");
}

describe("investigation target throttle", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockDb.slots.clear();
    installFakeMysqlSlotStore();
  });

  it("keeps auto fallback for non-LDAP local demo mode", async () => {
    const { createTargetThrottleStore } = await loadThrottleModule();

    expect(createTargetThrottleStore().mode).toBe("mysql-auto-fallback");
  });

  it("does not couple operator LDAP evidence credentials to the Cockpit throttle store", async () => {
    vi.stubEnv("INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS", "true");
    const { createTargetThrottleStore } = await loadThrottleModule();

    expect(createTargetThrottleStore().mode).toBe("mysql-auto-fallback");
  });

  it("requires durable MySQL target slots when explicitly configured", async () => {
    vi.stubEnv("INVESTIGATION_REQUIRE_DURABLE_TARGET_THROTTLE", "true");
    vi.stubEnv("INVESTIGATION_TARGET_THROTTLE_STORE", "memory");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createTargetThrottleStore } = await loadThrottleModule();

    expect(createTargetThrottleStore().mode).toBe("mysql");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("durable target slots are required"));
  });

  it("allows only one active MySQL slot per PROD LDAP DB target when cap is one", async () => {
    vi.stubEnv("INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS", "true");
    const { createTargetThrottleStore, normalizeTargetKey } = await loadThrottleModule();
    const store = createTargetThrottleStore();
    const targetKey = "Wellcare:PROD-REPLICA:wellcare-prod-db";

    const first = await store.claim({ targetKey, runId: "run-1", maxConcurrent: 1 });
    const second = await store.claim({ targetKey, runId: "run-2", maxConcurrent: 1 });

    expect(first).toMatchObject({
      acquired: true,
      targetKey: normalizeTargetKey(targetKey),
      slotNo: 1,
    });
    expect(second).toMatchObject({
      acquired: false,
      targetKey: normalizeTargetKey(targetKey),
      reason: "target limit reached (1 active slot)",
    });

    await store.release({ targetKey: first.targetKey, slotNo: first.slotNo ?? 1, runId: "run-1" });

    await expect(store.claim({ targetKey, runId: "run-2", maxConcurrent: 1 })).resolves.toMatchObject({
      acquired: true,
      slotNo: 1,
    });
  });

  it("fails closed instead of falling back to memory when LDAP mode cannot use MySQL slots", async () => {
    vi.stubEnv("INVESTIGATION_REQUIRE_DURABLE_TARGET_THROTTLE", "true");
    mockDb.pool.execute.mockRejectedValueOnce(new Error("investigation_target_slots missing"));
    const { createTargetThrottleStore } = await loadThrottleModule();
    const store = createTargetThrottleStore();

    await expect(store.claim({
      targetKey: "Wellcare:PROD-REPLICA:wellcare-prod-db",
      runId: "run-ldap",
      maxConcurrent: 1,
    })).rejects.toThrow("investigation_target_slots missing");

    expect(store.mode).toBe("mysql");
  });
});
