import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ComposeWorkspaceCleanupCandidate } from "./compose-database.js";

export interface ComposeRetentionRepository {
  listArchivedSessionsForWorkspaceCleanup(input: {
    archivedBefore: Date;
    limit: number;
  }): Promise<ComposeWorkspaceCleanupCandidate[]>;
  markWorkspaceCleaned(sessionId: number): Promise<void>;
  markWorkspaceCleanupFailed(input: {
    sessionId: number;
    errorMessage: string;
  }): Promise<void>;
  purgeExpiredStreamTokens(input: {
    expiredBefore: Date;
    limit: number;
  }): Promise<number>;
  purgeStaleWorkerHeartbeats(input: {
    heartbeatBefore: Date;
    limit: number;
  }): Promise<number>;
}

export interface ComposeRetentionCleanupOptions {
  olderThanDays?: number;
  limit?: number;
  dryRun?: boolean;
  now?: Date;
  workerHeartbeatRetentionDays?: number;
  workerHeartbeatLimit?: number;
}

export interface ComposeRetentionCleanupFailure {
  sessionId: number;
  workspacePath: string;
  errorMessage: string;
}

export interface ComposeRetentionCleanupSuccess {
  sessionId: number;
  workspacePath: string;
  filesDeleted: number;
  bytesDeleted: number;
  objectsDeleted: number;
  missing: boolean;
}

/** S3 side of retention cleanup. Optional so EFS-only callers/tests still work. */
export interface ComposeRetentionObjectStore {
  deletePrefix(s3Prefix: string): Promise<number>;
}

export interface ComposeRetentionCleanupResult {
  dryRun: boolean;
  archivedBefore: string;
  inspected: number;
  cleaned: number;
  wouldClean: number;
  failed: number;
  deletedFiles: number;
  deletedBytes: number;
  deletedObjects: number;
  purgedStreamTokens: number;
  purgedWorkerHeartbeats: number;
  successes: ComposeRetentionCleanupSuccess[];
  failures: ComposeRetentionCleanupFailure[];
}

interface FileSystemLike {
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
  lstat(path: string): Promise<Stats>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
}

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_LIMIT = 50;
const DEFAULT_WORKER_HEARTBEAT_RETENTION_DAYS = 7;
const DEFAULT_WORKER_HEARTBEAT_LIMIT = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function numericOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return Math.floor(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}

interface WorkspaceStats {
  files: number;
  bytes: number;
  missing: boolean;
}

async function collectWorkspaceStats(
  fs: FileSystemLike,
  workspacePath: string,
): Promise<WorkspaceStats> {
  try {
    const root = await fs.lstat(workspacePath);
    if (!root.isDirectory()) {
      return {
        files: root.isFile() ? 1 : 0,
        bytes: root.isFile() ? root.size : 0,
        missing: false,
      };
    }
  } catch (error) {
    if (isNotFound(error)) {
      return { files: 0, bytes: 0, missing: true };
    }
    return { files: 0, bytes: 0, missing: false };
  }

  let files = 0;
  let bytes = 0;

  async function walk(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      return;
    }

    for (const entry of entries) {
      const childPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath);
        continue;
      }

      try {
        const stats = await fs.lstat(childPath);
        if (stats.isDirectory()) {
          await walk(childPath);
        } else {
          files += 1;
          bytes += stats.size;
        }
      } catch {
        // Stats are advisory; deletion remains the source of truth.
      }
    }
  }

  await walk(workspacePath);
  return { files, bytes, missing: false };
}

export class ComposeRetentionCleaner {
  constructor(
    private readonly repository: ComposeRetentionRepository,
    private readonly fs: FileSystemLike = { rm, lstat, readdir },
    private readonly objectStore?: ComposeRetentionObjectStore,
  ) {}

  async cleanupArchivedWorkspaces(
    options: ComposeRetentionCleanupOptions = {},
  ): Promise<ComposeRetentionCleanupResult> {
    const olderThanDays = numericOption(
      options.olderThanDays,
      DEFAULT_RETENTION_DAYS,
      "olderThanDays",
    );
    const workerHeartbeatRetentionDays = numericOption(
      options.workerHeartbeatRetentionDays,
      DEFAULT_WORKER_HEARTBEAT_RETENTION_DAYS,
      "workerHeartbeatRetentionDays",
    );
    const workerHeartbeatLimit = numericOption(
      options.workerHeartbeatLimit,
      DEFAULT_WORKER_HEARTBEAT_LIMIT,
      "workerHeartbeatLimit",
    );
    const limit = numericOption(options.limit, DEFAULT_LIMIT, "limit");
    const dryRun = Boolean(options.dryRun);
    const now = options.now ?? new Date();
    const archivedBefore = new Date(now.getTime() - olderThanDays * MS_PER_DAY);
    const heartbeatBefore = new Date(
      now.getTime() - workerHeartbeatRetentionDays * MS_PER_DAY,
    );
    const candidates =
      await this.repository.listArchivedSessionsForWorkspaceCleanup({
        archivedBefore,
        limit,
      });

    const failures: ComposeRetentionCleanupFailure[] = [];
    const successes: ComposeRetentionCleanupSuccess[] = [];
    let cleaned = 0;
    let deletedFiles = 0;
    let deletedBytes = 0;
    let deletedObjects = 0;
    let purgedStreamTokens = 0;
    let purgedWorkerHeartbeats = 0;

    if (dryRun) {
      return {
        dryRun,
        archivedBefore: archivedBefore.toISOString(),
        inspected: candidates.length,
        cleaned: 0,
        wouldClean: candidates.length,
        failed: 0,
        deletedFiles: 0,
        deletedBytes: 0,
        deletedObjects: 0,
        purgedStreamTokens: 0,
        purgedWorkerHeartbeats: 0,
        successes,
        failures,
      };
    }

    purgedStreamTokens = await this.repository.purgeExpiredStreamTokens({
      expiredBefore: now,
      limit,
    });
    purgedWorkerHeartbeats =
      await this.repository.purgeStaleWorkerHeartbeats({
        heartbeatBefore,
        limit: workerHeartbeatLimit,
      });

    for (const candidate of candidates) {
      try {
        const stats = await collectWorkspaceStats(
          this.fs,
          candidate.workspacePath,
        );
        // Purge S3 raw uploads BEFORE the EFS rm + DB mark, so a failed S3
        // delete leaves the candidate uncleaned and retryable next run rather
        // than orphaning objects under a session we've marked done.
        let objectsDeleted = 0;
        if (this.objectStore && candidate.s3Prefix) {
          objectsDeleted = await this.objectStore.deletePrefix(
            candidate.s3Prefix,
          );
        }
        await this.fs.rm(candidate.workspacePath, {
          recursive: true,
          force: true,
        });
        await this.repository.markWorkspaceCleaned(candidate.id);
        cleaned += 1;
        deletedFiles += stats.files;
        deletedBytes += stats.bytes;
        deletedObjects += objectsDeleted;
        successes.push({
          sessionId: candidate.id,
          workspacePath: candidate.workspacePath,
          filesDeleted: stats.files,
          bytesDeleted: stats.bytes,
          objectsDeleted,
          missing: stats.missing,
        });
      } catch (error) {
        const message = errorMessage(error);
        failures.push({
          sessionId: candidate.id,
          workspacePath: candidate.workspacePath,
          errorMessage: message,
        });
        await this.repository.markWorkspaceCleanupFailed({
          sessionId: candidate.id,
          errorMessage: message,
        });
      }
    }

    return {
      dryRun,
      archivedBefore: archivedBefore.toISOString(),
      inspected: candidates.length,
      cleaned,
      wouldClean: 0,
      failed: failures.length,
      deletedFiles,
      deletedBytes,
      deletedObjects,
      purgedStreamTokens,
      purgedWorkerHeartbeats,
      successes,
      failures,
    };
  }
}
