export interface SpecFactoryRetentionPolicy {
  workspaceRetentionDays: number;
  cleanupLimit: number;
  cleanupDryRun: boolean;
  sweepIntervalMs: number;
  workerHeartbeatRetentionDays: number;
  workerHeartbeatLimit: number;
  tempArtifactRetentionHours: number;
  tempArtifactLimit: number;
  tempArtifactMaxDepth: number;
  llmAuditArtifactRetentionDays: number;
  llmAuditArtifactLimit: number;
  s3ReachabilityEnabled: boolean;
  s3ReachabilityLimit: number;
  outboxRetentionDays: number;
  queueReceiptRetentionDays: number;
  repairReconcileLimit: number;
  immutableArtifactRetentionHours: number;
  immutableArtifactGcLimit: number;
  strandedDispatchSeconds: number;
  sourceDeletionUndoMinutes: number;
  sourceDeletionSweepMs: number;
  sourceDeletionPurgeLimit: number;
}

export const DEFAULT_SPEC_FACTORY_RETENTION_POLICY: SpecFactoryRetentionPolicy =
  {
    workspaceRetentionDays: 30,
    cleanupLimit: 50,
    cleanupDryRun: false,
    sweepIntervalMs: 6 * 60 * 60 * 1000,
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
  };

function positiveNumberEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

function booleanEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function boundedPositiveNumberEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = positiveNumberEnv(env, name, fallback);
  if (value > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return value;
}

export function resolveSpecFactoryRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): SpecFactoryRetentionPolicy {
  const defaults = DEFAULT_SPEC_FACTORY_RETENTION_POLICY;
  return {
    workspaceRetentionDays: positiveNumberEnv(
      env,
      "COMPOSE_WORKSPACE_RETENTION_DAYS",
      defaults.workspaceRetentionDays,
    ),
    cleanupLimit: positiveNumberEnv(
      env,
      "COMPOSE_CLEANUP_LIMIT",
      defaults.cleanupLimit,
    ),
    cleanupDryRun: booleanEnv(env, "COMPOSE_CLEANUP_DRY_RUN"),
    sweepIntervalMs: positiveNumberEnv(
      env,
      "COMPOSE_RETENTION_SWEEP_MS",
      defaults.sweepIntervalMs,
    ),
    workerHeartbeatRetentionDays: positiveNumberEnv(
      env,
      "SPEC_FACTORY_WORKER_HEARTBEAT_RETENTION_DAYS",
      defaults.workerHeartbeatRetentionDays,
    ),
    workerHeartbeatLimit: positiveNumberEnv(
      env,
      "SPEC_FACTORY_WORKER_HEARTBEAT_GC_LIMIT",
      defaults.workerHeartbeatLimit,
    ),
    tempArtifactRetentionHours: positiveNumberEnv(
      env,
      "COMPOSE_ARTIFACT_TMP_RETENTION_HOURS",
      defaults.tempArtifactRetentionHours,
    ),
    tempArtifactLimit: positiveNumberEnv(
      env,
      "COMPOSE_ARTIFACT_GC_LIMIT",
      defaults.tempArtifactLimit,
    ),
    tempArtifactMaxDepth: positiveNumberEnv(
      env,
      "COMPOSE_ARTIFACT_GC_MAX_DEPTH",
      defaults.tempArtifactMaxDepth,
    ),
    llmAuditArtifactRetentionDays: positiveNumberEnv(
      env,
      "SPEC_FACTORY_LLM_AUDIT_ARTIFACT_RETENTION_DAYS",
      defaults.llmAuditArtifactRetentionDays,
    ),
    llmAuditArtifactLimit: positiveNumberEnv(
      env,
      "SPEC_FACTORY_LLM_AUDIT_ARTIFACT_GC_LIMIT",
      defaults.llmAuditArtifactLimit,
    ),
    s3ReachabilityEnabled: booleanEnv(
      env,
      "COMPOSE_S3_REACHABILITY_GC_ENABLED",
    ),
    s3ReachabilityLimit: positiveNumberEnv(
      env,
      "COMPOSE_S3_REACHABILITY_GC_LIMIT",
      defaults.s3ReachabilityLimit,
    ),
    outboxRetentionDays: positiveNumberEnv(
      env,
      "SPEC_FACTORY_OUTBOX_RETENTION_DAYS",
      defaults.outboxRetentionDays,
    ),
    queueReceiptRetentionDays: positiveNumberEnv(
      env,
      "SPEC_FACTORY_QUEUE_RECEIPT_RETENTION_DAYS",
      defaults.queueReceiptRetentionDays,
    ),
    repairReconcileLimit: positiveNumberEnv(
      env,
      "SPEC_FACTORY_REPAIR_RECONCILE_LIMIT",
      defaults.repairReconcileLimit,
    ),
    immutableArtifactRetentionHours: positiveNumberEnv(
      env,
      "SPEC_FACTORY_IMMUTABLE_ARTIFACT_ORPHAN_GRACE_HOURS",
      defaults.immutableArtifactRetentionHours,
    ),
    immutableArtifactGcLimit: positiveNumberEnv(
      env,
      "SPEC_FACTORY_IMMUTABLE_ARTIFACT_GC_LIMIT",
      defaults.immutableArtifactGcLimit,
    ),
    strandedDispatchSeconds: positiveNumberEnv(
      env,
      "SPEC_FACTORY_STRANDED_DISPATCH_SECONDS",
      defaults.strandedDispatchSeconds,
    ),
    sourceDeletionUndoMinutes: boundedPositiveNumberEnv(
      env,
      "SPEC_FACTORY_SOURCE_DELETE_UNDO_MINUTES",
      defaults.sourceDeletionUndoMinutes,
      10_080,
    ),
    sourceDeletionSweepMs: positiveNumberEnv(
      env,
      "SPEC_FACTORY_SOURCE_DELETE_SWEEP_MS",
      defaults.sourceDeletionSweepMs,
    ),
    sourceDeletionPurgeLimit: positiveNumberEnv(
      env,
      "SPEC_FACTORY_SOURCE_DELETE_PURGE_LIMIT",
      defaults.sourceDeletionPurgeLimit,
    ),
  };
}
