import { describe, expect, it, vi } from "vitest";
import { SpecFactoryControlPlaneMaintenance } from "./maintenance.js";

describe("SpecFactoryControlPlaneMaintenance", () => {
  it("recovers leases before purging bounded terminal history", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([{ affectedRows: 7 }])
      .mockResolvedValueOnce([{ affectedRows: 3 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 4 }])
      .mockResolvedValueOnce([{ affectedRows: 5 }])
      .mockResolvedValueOnce([{ affectedRows: 6 }]);
    const maintenance = new SpecFactoryControlPlaneMaintenance({
      query,
    } as never);
    await expect(
      maintenance.run({ now: new Date("2026-07-10T00:00:00.000Z"), limit: 20 }),
    ).resolves.toEqual({
      recoveredOutboxRows: 2,
      requeuedStrandedDispatches: 7,
      recoveredDraftStages: 3,
      terminalDraftStages: 1,
      recoveredQueueReceipts: 4,
      purgedQueueReceipts: 5,
      purgedOutboxRows: 6,
    });
    expect(String(query.mock.calls[0][0])).toContain(
      "publishing_lease_expired",
    );
    expect(String(query.mock.calls[1][0])).toContain(
      "authoritative_work_still_queued",
    );
    expect(String(query.mock.calls[1][0])).toContain(
      "receipt.status = 'completed'",
    );
    expect(String(query.mock.calls[2][0])).toContain(
      "spec_factory_draft_stage_runs",
    );
    expect(String(query.mock.calls[3][0])).toContain(
      "LEFT JOIN compose_handoffs",
    );
    expect(String(query.mock.calls[4][0])).toContain(
      "processing_lease_expired",
    );
    expect(String(query.mock.calls[6][0])).toContain(
      "receipt.outbox_id = spec_factory_outbox.id",
    );
  });
});
