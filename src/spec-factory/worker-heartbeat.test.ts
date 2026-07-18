import { describe, expect, it, vi } from "vitest";
import { SpecFactoryWorkerHeartbeatRepository } from "./worker-heartbeat.js";

describe("SpecFactoryWorkerHeartbeatRepository", () => {
  it("upserts worker heartbeat inventory with sorted capabilities", async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const repository = new SpecFactoryWorkerHeartbeatRepository({
      query,
    } as never);
    const startedAt = new Date("2026-07-06T05:00:00.000Z");
    const heartbeatAt = new Date("2026-07-06T05:00:15.000Z");

    await repository.recordHeartbeat({
      workerId: "worker-a",
      mode: "worker",
      hostname: "host-a",
      processId: 123,
      capabilities: ["durable_turn_worker", "agent_task:context_merge"],
      startedAt,
      heartbeatAt,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO spec_factory_worker_heartbeats"),
      [
        "worker-a",
        "worker",
        "host-a",
        123,
        JSON.stringify(["agent_task:context_merge", "durable_turn_worker"]),
        startedAt,
        heartbeatAt,
      ],
    );
    expect(String(query.mock.calls[0][0])).toContain(
      "ON DUPLICATE KEY UPDATE",
    );
  });
});
