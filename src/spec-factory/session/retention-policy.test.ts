import { describe, expect, it } from "vitest";
import { resolveSpecFactoryRetentionPolicy } from "./retention-policy.js";

describe("resolveSpecFactoryRetentionPolicy", () => {
  it("uses conservative retention defaults", () => {
    expect(resolveSpecFactoryRetentionPolicy({})).toEqual({
      workspaceRetentionDays: 30,
      cleanupLimit: 50,
      cleanupDryRun: false,
      sweepIntervalMs: 21_600_000,
      workerHeartbeatRetentionDays: 7,
      workerHeartbeatLimit: 500,
      tempArtifactRetentionHours: 24,
      tempArtifactLimit: 500,
      tempArtifactMaxDepth: 6,
      llmAuditArtifactRetentionDays: 30,
      llmAuditArtifactLimit: 500,
      s3ReachabilityEnabled: false,
      s3ReachabilityLimit: 1000,
      outboxRetentionDays: 14,
      queueReceiptRetentionDays: 7,
      repairReconcileLimit: 100,
      immutableArtifactRetentionHours: 24,
      immutableArtifactGcLimit: 5000,
      strandedDispatchSeconds: 300,
      sourceDeletionUndoMinutes: 10,
      sourceDeletionSweepMs: 60_000,
      sourceDeletionPurgeLimit: 50,
    });
  });

  it("resolves cleanup and artifact GC environment overrides", () => {
    expect(
      resolveSpecFactoryRetentionPolicy({
        COMPOSE_WORKSPACE_RETENTION_DAYS: "14",
        COMPOSE_CLEANUP_LIMIT: "25",
        COMPOSE_CLEANUP_DRY_RUN: "yes",
        COMPOSE_RETENTION_SWEEP_MS: "60000",
        SPEC_FACTORY_WORKER_HEARTBEAT_RETENTION_DAYS: "3",
        SPEC_FACTORY_WORKER_HEARTBEAT_GC_LIMIT: "80",
        COMPOSE_ARTIFACT_TMP_RETENTION_HOURS: "6",
        COMPOSE_ARTIFACT_GC_LIMIT: "75",
        COMPOSE_ARTIFACT_GC_MAX_DEPTH: "4",
        SPEC_FACTORY_LLM_AUDIT_ARTIFACT_RETENTION_DAYS: "45",
        SPEC_FACTORY_LLM_AUDIT_ARTIFACT_GC_LIMIT: "125",
        COMPOSE_S3_REACHABILITY_GC_ENABLED: "true",
        COMPOSE_S3_REACHABILITY_GC_LIMIT: "250",
        SPEC_FACTORY_OUTBOX_RETENTION_DAYS: "21",
        SPEC_FACTORY_QUEUE_RECEIPT_RETENTION_DAYS: "11",
        SPEC_FACTORY_REPAIR_RECONCILE_LIMIT: "75",
        SPEC_FACTORY_IMMUTABLE_ARTIFACT_ORPHAN_GRACE_HOURS: "48",
        SPEC_FACTORY_IMMUTABLE_ARTIFACT_GC_LIMIT: "8000",
        SPEC_FACTORY_STRANDED_DISPATCH_SECONDS: "600",
        SPEC_FACTORY_SOURCE_DELETE_UNDO_MINUTES: "15",
        SPEC_FACTORY_SOURCE_DELETE_SWEEP_MS: "30000",
        SPEC_FACTORY_SOURCE_DELETE_PURGE_LIMIT: "20",
      }),
    ).toEqual({
      workspaceRetentionDays: 14,
      cleanupLimit: 25,
      cleanupDryRun: true,
      sweepIntervalMs: 60_000,
      workerHeartbeatRetentionDays: 3,
      workerHeartbeatLimit: 80,
      tempArtifactRetentionHours: 6,
      tempArtifactLimit: 75,
      tempArtifactMaxDepth: 4,
      llmAuditArtifactRetentionDays: 45,
      llmAuditArtifactLimit: 125,
      s3ReachabilityEnabled: true,
      s3ReachabilityLimit: 250,
      outboxRetentionDays: 21,
      queueReceiptRetentionDays: 11,
      repairReconcileLimit: 75,
      immutableArtifactRetentionHours: 48,
      immutableArtifactGcLimit: 8000,
      strandedDispatchSeconds: 600,
      sourceDeletionUndoMinutes: 15,
      sourceDeletionSweepMs: 30_000,
      sourceDeletionPurgeLimit: 20,
    });
  });

  it("rejects non-positive numeric overrides", () => {
    expect(() =>
      resolveSpecFactoryRetentionPolicy({
        COMPOSE_ARTIFACT_GC_LIMIT: "0",
      }),
    ).toThrow("COMPOSE_ARTIFACT_GC_LIMIT must be a positive number");
    expect(() =>
      resolveSpecFactoryRetentionPolicy({
        SPEC_FACTORY_SOURCE_DELETE_UNDO_MINUTES: "10081",
      }),
    ).toThrow("SPEC_FACTORY_SOURCE_DELETE_UNDO_MINUTES must be at most 10080");
  });
});
