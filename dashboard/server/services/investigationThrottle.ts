import type mysql from "mysql2/promise";
import { getPool } from "../db.js";

export interface TargetThrottleClaimInput {
  targetKey: string;
  runId: string;
  maxConcurrent: number;
  leaseSeconds?: number;
}

export interface TargetThrottleClaim {
  acquired: boolean;
  targetKey: string;
  slotNo?: number;
  reason?: string;
}

export interface TargetThrottleStore {
  readonly mode: "mysql" | "memory" | "mysql-auto-fallback";
  claim(input: TargetThrottleClaimInput): Promise<TargetThrottleClaim>;
  heartbeat(claim: Required<Pick<TargetThrottleClaim, "targetKey" | "slotNo">> & { runId: string; leaseSeconds?: number }): Promise<void>;
  release(claim: Required<Pick<TargetThrottleClaim, "targetKey" | "slotNo">> & { runId: string }): Promise<void>;
}

const DEFAULT_LEASE_SECONDS = 30 * 60;

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function clampMaxConcurrent(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(20, Math.floor(value)));
}

export function environmentTargetCap(environment: string): number {
  return environment.toUpperCase().startsWith("PROD") ? 1 : 2;
}

export function normalizeTargetKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 220);
}

class MySqlTargetThrottleStore implements TargetThrottleStore {
  readonly mode = "mysql" as const;

  async claim(input: TargetThrottleClaimInput): Promise<TargetThrottleClaim> {
    const targetKey = normalizeTargetKey(input.targetKey);
    const maxConcurrent = clampMaxConcurrent(input.maxConcurrent);
    const leaseSeconds = Math.max(30, Math.floor(input.leaseSeconds || DEFAULT_LEASE_SECONDS));

    await this.ensureSlots(targetKey, maxConcurrent);

    const [result] = await getPool().execute<mysql.ResultSetHeader>(
      `UPDATE investigation_target_slots
          SET run_id = ?,
              lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
              heartbeat_at = UTC_TIMESTAMP(3)
        WHERE target_key = ?
          AND slot_no <= ?
          AND (run_id IS NULL OR lease_expires_at < UTC_TIMESTAMP(3))
        ORDER BY slot_no
        LIMIT 1`,
      [input.runId, leaseSeconds, targetKey, maxConcurrent],
    );

    if (result.affectedRows < 1) {
      return {
        acquired: false,
        targetKey,
        reason: `target limit reached (${maxConcurrent} active slot${maxConcurrent === 1 ? "" : "s"})`,
      };
    }

    const [rows] = await getPool().execute<Array<mysql.RowDataPacket & { slot_no: number }>>(
      `SELECT slot_no
         FROM investigation_target_slots
        WHERE target_key = ?
          AND run_id = ?
        ORDER BY slot_no
        LIMIT 1`,
      [targetKey, input.runId],
    );

    return {
      acquired: true,
      targetKey,
      slotNo: rows[0]?.slot_no ?? 1,
    };
  }

  async heartbeat(claim: Required<Pick<TargetThrottleClaim, "targetKey" | "slotNo">> & { runId: string; leaseSeconds?: number }): Promise<void> {
    const leaseSeconds = Math.max(30, Math.floor(claim.leaseSeconds || DEFAULT_LEASE_SECONDS));
    await getPool().execute(
      `UPDATE investigation_target_slots
          SET lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
              heartbeat_at = UTC_TIMESTAMP(3)
        WHERE target_key = ?
          AND slot_no = ?
          AND run_id = ?`,
      [leaseSeconds, claim.targetKey, claim.slotNo, claim.runId],
    );
  }

  async release(claim: Required<Pick<TargetThrottleClaim, "targetKey" | "slotNo">> & { runId: string }): Promise<void> {
    await getPool().execute(
      `UPDATE investigation_target_slots
          SET run_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = UTC_TIMESTAMP(3)
        WHERE target_key = ?
          AND slot_no = ?
          AND run_id = ?`,
      [claim.targetKey, claim.slotNo, claim.runId],
    );
  }

  private async ensureSlots(targetKey: string, maxConcurrent: number): Promise<void> {
    for (let slotNo = 1; slotNo <= maxConcurrent; slotNo += 1) {
      await getPool().execute(
        `INSERT IGNORE INTO investigation_target_slots (target_key, slot_no)
         VALUES (?, ?)`,
        [targetKey, slotNo],
      );
    }
  }
}

class InMemoryTargetThrottleStore implements TargetThrottleStore {
  readonly mode = "memory" as const;
  private readonly slots = new Map<string, Array<{ slotNo: number; runId: string | null; leaseExpiresAt: number | null }>>();

  async claim(input: TargetThrottleClaimInput): Promise<TargetThrottleClaim> {
    const targetKey = normalizeTargetKey(input.targetKey);
    const maxConcurrent = clampMaxConcurrent(input.maxConcurrent);
    const leaseMs = Math.max(30, Math.floor(input.leaseSeconds || DEFAULT_LEASE_SECONDS)) * 1000;
    const now = Date.now();
    const slots = this.ensureSlots(targetKey, maxConcurrent);
    const available = slots.find((slot) => !slot.runId || (slot.leaseExpiresAt ?? 0) < now);

    if (!available) {
      return {
        acquired: false,
        targetKey,
        reason: `target limit reached (${maxConcurrent} active slot${maxConcurrent === 1 ? "" : "s"})`,
      };
    }

    available.runId = input.runId;
    available.leaseExpiresAt = now + leaseMs;
    return {
      acquired: true,
      targetKey,
      slotNo: available.slotNo,
    };
  }

  async heartbeat(claim: Required<Pick<TargetThrottleClaim, "targetKey" | "slotNo">> & { runId: string; leaseSeconds?: number }): Promise<void> {
    const slot = this.slots.get(claim.targetKey)?.find((entry) => entry.slotNo === claim.slotNo && entry.runId === claim.runId);
    if (slot) {
      slot.leaseExpiresAt = Date.now() + Math.max(30, Math.floor(claim.leaseSeconds || DEFAULT_LEASE_SECONDS)) * 1000;
    }
  }

  async release(claim: Required<Pick<TargetThrottleClaim, "targetKey" | "slotNo">> & { runId: string }): Promise<void> {
    const slot = this.slots.get(claim.targetKey)?.find((entry) => entry.slotNo === claim.slotNo && entry.runId === claim.runId);
    if (slot) {
      slot.runId = null;
      slot.leaseExpiresAt = null;
    }
  }

  private ensureSlots(targetKey: string, maxConcurrent: number) {
    const current = this.slots.get(targetKey) || [];
    for (let slotNo = current.length + 1; slotNo <= maxConcurrent; slotNo += 1) {
      current.push({ slotNo, runId: null, leaseExpiresAt: null });
    }
    this.slots.set(targetKey, current);
    return current.filter((slot) => slot.slotNo <= maxConcurrent);
  }
}

class AutoFallbackTargetThrottleStore implements TargetThrottleStore {
  readonly mode = "mysql-auto-fallback" as const;
  private readonly mysql = new MySqlTargetThrottleStore();
  private readonly memory = new InMemoryTargetThrottleStore();
  private fallback = false;
  private warned = false;

  async claim(input: TargetThrottleClaimInput): Promise<TargetThrottleClaim> {
    if (this.fallback) {
      return this.memory.claim(input);
    }
    try {
      return await this.mysql.claim(input);
    } catch (error) {
      this.fallback = true;
      if (!this.warned) {
        this.warned = true;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[investigation-throttle] MySQL throttle unavailable; using in-memory POC throttle: ${message}`);
      }
      return this.memory.claim(input);
    }
  }

  async heartbeat(claim: Required<Pick<TargetThrottleClaim, "targetKey" | "slotNo">> & { runId: string; leaseSeconds?: number }): Promise<void> {
    if (this.fallback) {
      await this.memory.heartbeat(claim);
      return;
    }
    await this.mysql.heartbeat(claim);
  }

  async release(claim: Required<Pick<TargetThrottleClaim, "targetKey" | "slotNo">> & { runId: string }): Promise<void> {
    if (this.fallback) {
      await this.memory.release(claim);
      return;
    }
    await this.mysql.release(claim);
  }
}

export function createTargetThrottleStore(): TargetThrottleStore {
  const mode = (process.env.INVESTIGATION_TARGET_THROTTLE_STORE || "auto").trim().toLowerCase();
  const durableThrottleRequired = envFlag("INVESTIGATION_REQUIRE_DURABLE_TARGET_THROTTLE");
  if (durableThrottleRequired) {
    if (mode === "memory" || mode === "in-memory" || mode === "in_memory") {
      console.warn("[investigation-throttle] Ignoring in-memory target throttle because durable target slots are required");
    }
    return new MySqlTargetThrottleStore();
  }
  if (mode === "memory" || mode === "in-memory" || mode === "in_memory") {
    return new InMemoryTargetThrottleStore();
  }
  if (mode === "mysql") {
    return new MySqlTargetThrottleStore();
  }
  return new AutoFallbackTargetThrottleStore();
}
