import { getDatabase, initDatabase } from "../orchestrator/database.js";
import { ComposeArtifactGc } from "./compose-artifact-gc.js";
import { ComposeRepository } from "./compose-database.js";
import { ComposeHardDeleteService } from "./compose-hard-delete.js";
import { ComposeRetentionCleaner } from "./compose-retention.js";
import { ComposeSourceDeletionCleaner } from "./compose-source-deletion.js";
import { ComposeS3ReachabilityGc } from "./compose-s3-reachability-gc.js";
import { ComposeUploads } from "./compose-uploads.js";
import { SpecFactoryLlmCallAuditRepository } from "./llm/llm-audit.js";
import { LlmAuditArtifactRetentionCleaner } from "./llm/llm-audit-retention.js";
import { resolveSpecFactoryRetentionPolicy } from "./session/retention-policy.js";

const DEFAULT_COMPOSE_WORKSPACE_BASE =
  "/mnt/efs/specter-repo/spec-factory/compose";

function booleanEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function booleanEnvDefault(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return booleanEnv(name);
}

function optionalNumberEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

function composeWorkspaceBase(): string {
  return (
    process.env.COMPOSE_WORKSPACE_BASE?.trim() || DEFAULT_COMPOSE_WORKSPACE_BASE
  );
}

function composeS3RootPrefix(): string {
  const raw = process.env.COMPOSE_S3_PREFIX?.trim() || "compose";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function llmAuditArtifactBase(): string | null {
  return process.env.SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE?.trim() || null;
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    const hardDeleteSessionId = optionalNumberEnv(
      "COMPOSE_HARD_DELETE_SESSION_ID",
    );
    if (hardDeleteSessionId !== null) {
      const hardDelete = await new ComposeHardDeleteService(
        new ComposeRepository(),
        undefined,
        new ComposeUploads(),
      ).hardDeleteSession({
        sessionId: hardDeleteSessionId,
        dryRun: booleanEnvDefault("COMPOSE_HARD_DELETE_DRY_RUN", true),
        confirm: process.env.COMPOSE_HARD_DELETE_CONFIRM?.trim() || null,
        auditArtifactBasePath: llmAuditArtifactBase(),
      });
      console.log(JSON.stringify({ hardDelete }, null, 2));
      return;
    }

    const retentionPolicy = resolveSpecFactoryRetentionPolicy();
    const repository = new ComposeRepository();
    const uploads = new ComposeUploads();
    const cleaner = new ComposeRetentionCleaner(repository, undefined, uploads);
    const retention = await cleaner.cleanupArchivedWorkspaces({
      olderThanDays: retentionPolicy.workspaceRetentionDays,
      limit: retentionPolicy.cleanupLimit,
      dryRun: retentionPolicy.cleanupDryRun,
      workerHeartbeatRetentionDays:
        retentionPolicy.workerHeartbeatRetentionDays,
      workerHeartbeatLimit: retentionPolicy.workerHeartbeatLimit,
    });
    const sourceDeletions = retentionPolicy.cleanupDryRun
      ? null
      : await new ComposeSourceDeletionCleaner(
          repository,
          uploads,
        ).cleanupExpiredSourceDeletions({
          limit: retentionPolicy.sourceDeletionPurgeLimit,
        });
    const tempArtifacts = await new ComposeArtifactGc(
      composeWorkspaceBase(),
    ).cleanupTemporaryArtifacts({
      olderThanHours: retentionPolicy.tempArtifactRetentionHours,
      limit: retentionPolicy.tempArtifactLimit,
      maxDepth: retentionPolicy.tempArtifactMaxDepth,
      dryRun: retentionPolicy.cleanupDryRun,
    });
    const llmAuditArtifactBasePath = llmAuditArtifactBase();
    const llmAuditArtifacts = llmAuditArtifactBasePath
      ? await new LlmAuditArtifactRetentionCleaner(
          new SpecFactoryLlmCallAuditRepository(),
          llmAuditArtifactBasePath,
        ).cleanupAuditArtifacts({
          olderThanDays: retentionPolicy.llmAuditArtifactRetentionDays,
          limit: retentionPolicy.llmAuditArtifactLimit,
          dryRun: retentionPolicy.cleanupDryRun,
        })
      : null;
    const s3Reachability = retentionPolicy.s3ReachabilityEnabled
      ? await new ComposeS3ReachabilityGc(
          repository,
          uploads,
        ).cleanupOrphanedObjects({
          rootPrefix: composeS3RootPrefix(),
          dryRun: retentionPolicy.cleanupDryRun,
          limit: retentionPolicy.s3ReachabilityLimit,
        })
      : null;
    console.log(
      JSON.stringify(
        {
          retention,
          sourceDeletions,
          tempArtifacts,
          llmAuditArtifacts,
          s3Reachability,
        },
        null,
        2,
      ),
    );
    if (
      retention.failed > 0 ||
      (sourceDeletions?.failed ?? 0) > 0 ||
      tempArtifacts.failed > 0 ||
      (llmAuditArtifacts?.failed ?? 0) > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    await getDatabase().disconnect();
  }
}

main().catch(async (error) => {
  console.error("Compose retention cleanup failed", error);
  try {
    await getDatabase().disconnect();
  } catch {
    // Best effort shutdown after a startup or cleanup failure.
  }
  process.exit(1);
});
