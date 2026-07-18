import os from "os";
import type mysql from "mysql2/promise";
import { getDatabase } from "../orchestrator/database.js";

export type WorkerHeartbeatPool = Pick<mysql.Pool, "query">;

export interface SpecFactoryWorkerHeartbeatInput {
  workerId: string;
  mode: string;
  hostname?: string | null;
  processId?: number | null;
  capabilities: string[];
  startedAt: Date;
  heartbeatAt: Date;
}

export class SpecFactoryWorkerHeartbeatRepository {
  constructor(
    private readonly pool: WorkerHeartbeatPool = getDatabase().getPool(),
  ) {}

  async recordHeartbeat(
    input: SpecFactoryWorkerHeartbeatInput,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO spec_factory_worker_heartbeats
       (worker_id, mode, hostname, process_id, capabilities_json, started_at,
        heartbeat_at, updated_at)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         mode = VALUES(mode),
         hostname = VALUES(hostname),
         process_id = VALUES(process_id),
         capabilities_json = VALUES(capabilities_json),
         started_at = VALUES(started_at),
         heartbeat_at = VALUES(heartbeat_at),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [
        input.workerId,
        input.mode,
        input.hostname ?? os.hostname(),
        input.processId ?? process.pid,
        JSON.stringify(input.capabilities.filter(Boolean).sort()),
        input.startedAt,
        input.heartbeatAt,
      ],
    );
  }
}
