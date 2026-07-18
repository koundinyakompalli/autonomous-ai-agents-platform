import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DraftWorkflowWorker } from "./draft-workflow-worker.js";
import type { ClaimedDraftStageRun } from "./draft-workflow-types.js";

function run(
  stageName: ClaimedDraftStageRun["stageName"],
): ClaimedDraftStageRun {
  return {
    id: 11,
    workflowId: 7,
    sourceId: 5,
    handoffSnapshotId: 3,
    stageName,
    stageOrder: 2,
    attemptCount: 1,
    leaseGeneration: 4,
    workerId: "draft-1",
    input: {},
    priorOutputs: { evidence_snapshot: { snapshotId: 9 } },
  };
}

describe("DraftWorkflowWorker", () => {
  it("completes only the claimed stage and preserves prior outputs", async () => {
    const stage = run("repository_context");
    const store = {
      claimNextDraftStage: vi
        .fn()
        .mockResolvedValueOnce(stage)
        .mockResolvedValue(null),
      completeDraftStage: vi.fn().mockResolvedValue(true),
      failDraftStage: vi.fn(),
    };
    const handler = vi.fn().mockResolvedValue({ output: { repos: ["core"] } });
    const worker = new DraftWorkflowWorker(store, {
      workerId: "draft-1",
      concurrency: 1,
      handlers: { repository_context: handler },
    });

    await expect(worker.drain()).resolves.toBe(1);
    expect(handler).toHaveBeenCalledWith(stage);
    expect(handler.mock.calls[0][0].priorOutputs.evidence_snapshot).toEqual({
      snapshotId: 9,
    });
    expect(store.completeDraftStage).toHaveBeenCalledTimes(1);
  });

  it("requeues only the failed stage through the store fence", async () => {
    const stage = run("draft_synthesize");
    const store = {
      claimNextDraftStage: vi
        .fn()
        .mockResolvedValueOnce(stage)
        .mockResolvedValue(null),
      completeDraftStage: vi.fn(),
      failDraftStage: vi.fn().mockResolvedValue(true),
    };
    const worker = new DraftWorkflowWorker(store, {
      workerId: "draft-1",
      concurrency: 1,
      handlers: {
        draft_synthesize: vi
          .fn()
          .mockRejectedValue(new Error("503 unavailable")),
      },
    });

    await expect(worker.drain()).resolves.toBe(0);
    expect(store.completeDraftStage).not.toHaveBeenCalled();
    expect(store.failDraftStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stageRun: stage,
        retryable: true,
        errorCode: "provider_unavailable",
      }),
    );
  });

  it("verifies prior immutable artifacts and stores only the next artifact pointer in MySQL", async () => {
    const priorBody = Buffer.from(JSON.stringify({ snapshotId: 9 }), "utf8");
    const priorSha256 = createHash("sha256").update(priorBody).digest("hex");
    const stage = {
      ...run("repository_context"),
      priorOutputs: {
        evidence_snapshot: {
          artifactUri: "s3://bucket/prior.json",
          sha256: priorSha256,
          bytes: priorBody.byteLength,
        },
      },
    };
    const store = {
      claimNextDraftStage: vi
        .fn()
        .mockResolvedValueOnce(stage)
        .mockResolvedValue(null),
      completeDraftStage: vi.fn().mockResolvedValue(true),
      failDraftStage: vi.fn(),
    };
    const artifactStore = {
      read: vi.fn().mockResolvedValue(priorBody),
      write: vi.fn().mockResolvedValue({
        artifactUri: "s3://bucket/current.json",
        sha256: "b".repeat(64),
        bytes: 42,
      }),
    };
    const handler = vi.fn().mockResolvedValue({ output: { repos: ["core"] } });
    const worker = new DraftWorkflowWorker(store, {
      workerId: "draft-1",
      concurrency: 1,
      handlers: { repository_context: handler },
      artifactStore: artifactStore as never,
    });

    await expect(worker.drain()).resolves.toBe(1);
    expect(handler.mock.calls[0][0].priorOutputs.evidence_snapshot).toEqual({
      snapshotId: 9,
    });
    expect(artifactStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "spec-factory/workflows/7",
        relativePath: "stages/repository_context/attempt-1.json",
      }),
    );
    expect(store.completeDraftStage).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          databaseOutput: {
            artifactUri: "s3://bucket/current.json",
            sha256: "b".repeat(64),
            bytes: 42,
          },
        }),
      }),
    );
  });
});
