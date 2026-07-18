import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

export interface ComposeArtifactGcOptions {
  olderThanHours?: number;
  limit?: number;
  dryRun?: boolean;
  now?: Date;
  maxDepth?: number;
}

export interface ComposeArtifactGcFailure {
  path: string;
  errorMessage: string;
}

export interface ComposeArtifactGcResult {
  dryRun: boolean;
  workspaceBase: string;
  olderThanHours: number;
  cutoff: string;
  inspectedTmpDirs: number;
  deletedArtifacts: number;
  wouldDeleteArtifacts: number;
  deletedBytes: number;
  wouldDeleteBytes: number;
  failed: number;
  failures: ComposeArtifactGcFailure[];
}

interface FileSystemLike {
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
  lstat(path: string): Promise<Stats>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
}

interface ArtifactStats {
  files: number;
  bytes: number;
}

interface GcState {
  dryRun: boolean;
  cutoffMs: number;
  maxDepth: number;
  limit: number;
  inspectedTmpDirs: number;
  deletedArtifacts: number;
  wouldDeleteArtifacts: number;
  deletedBytes: number;
  wouldDeleteBytes: number;
  failures: ComposeArtifactGcFailure[];
}

const DEFAULT_TMP_ARTIFACT_RETENTION_HOURS = 24;
const DEFAULT_TMP_ARTIFACT_LIMIT = 500;
const DEFAULT_MAX_DEPTH = 6;
const MS_PER_HOUR = 60 * 60 * 1000;

function positiveIntegerOption(
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

function normalizeWorkspaceBase(workspaceBase: string): string {
  const trimmed = workspaceBase.trim();
  if (!trimmed) {
    throw new Error("workspaceBase is required for artifact GC");
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error("workspaceBase must be an absolute path");
  }
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root) {
    throw new Error("workspaceBase must not be the filesystem root");
  }
  return resolved;
}

export class ComposeArtifactGc {
  constructor(
    private readonly workspaceBase: string,
    private readonly fs: FileSystemLike = { rm, lstat, readdir },
  ) {}

  async cleanupTemporaryArtifacts(
    options: ComposeArtifactGcOptions = {},
  ): Promise<ComposeArtifactGcResult> {
    const workspaceBase = normalizeWorkspaceBase(this.workspaceBase);
    const olderThanHours = positiveIntegerOption(
      options.olderThanHours,
      DEFAULT_TMP_ARTIFACT_RETENTION_HOURS,
      "olderThanHours",
    );
    const limit = positiveIntegerOption(
      options.limit,
      DEFAULT_TMP_ARTIFACT_LIMIT,
      "limit",
    );
    const maxDepth = positiveIntegerOption(
      options.maxDepth,
      DEFAULT_MAX_DEPTH,
      "maxDepth",
    );
    const dryRun = Boolean(options.dryRun);
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - olderThanHours * MS_PER_HOUR);
    const state: GcState = {
      dryRun,
      cutoffMs: cutoff.getTime(),
      maxDepth,
      limit,
      inspectedTmpDirs: 0,
      deletedArtifacts: 0,
      wouldDeleteArtifacts: 0,
      deletedBytes: 0,
      wouldDeleteBytes: 0,
      failures: [],
    };

    await this.walkForTmpDirs(workspaceBase, 0, state);

    return {
      dryRun,
      workspaceBase,
      olderThanHours,
      cutoff: cutoff.toISOString(),
      inspectedTmpDirs: state.inspectedTmpDirs,
      deletedArtifacts: state.deletedArtifacts,
      wouldDeleteArtifacts: state.wouldDeleteArtifacts,
      deletedBytes: state.deletedBytes,
      wouldDeleteBytes: state.wouldDeleteBytes,
      failed: state.failures.length,
      failures: state.failures,
    };
  }

  private async walkForTmpDirs(
    directory: string,
    depth: number,
    state: GcState,
  ): Promise<void> {
    if (artifactLimitReached(state) || depth > state.maxDepth) return;

    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      recordFailure(state, directory, error);
      return;
    }

    for (const entry of entries) {
      if (artifactLimitReached(state)) return;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;

      const childPath = path.join(directory, entry.name);
      if (entry.name === ".tmp") {
        await this.cleanupTmpDir(childPath, state);
        continue;
      }
      await this.walkForTmpDirs(childPath, depth + 1, state);
    }
  }

  private async cleanupTmpDir(
    tmpDir: string,
    state: GcState,
  ): Promise<void> {
    state.inspectedTmpDirs += 1;
    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(tmpDir, { withFileTypes: true });
    } catch (error) {
      recordFailure(state, tmpDir, error);
      return;
    }

    for (const entry of entries) {
      if (artifactLimitReached(state)) return;
      if (entry.isSymbolicLink()) continue;
      const artifactPath = path.join(tmpDir, entry.name);
      let stats: Stats;
      try {
        stats = await this.fs.lstat(artifactPath);
      } catch (error) {
        recordFailure(state, artifactPath, error);
        continue;
      }
      if (stats.mtimeMs > state.cutoffMs) continue;

      const artifactStats = entry.isDirectory()
        ? await this.collectStats(artifactPath, state)
        : {
            files: stats.isFile() ? 1 : 0,
            bytes: stats.isFile() ? stats.size : 0,
          };
      if (state.dryRun) {
        state.wouldDeleteArtifacts += 1;
        state.wouldDeleteBytes += artifactStats.bytes;
        continue;
      }
      try {
        await this.fs.rm(artifactPath, { recursive: true, force: true });
        state.deletedArtifacts += 1;
        state.deletedBytes += artifactStats.bytes;
      } catch (error) {
        recordFailure(state, artifactPath, error);
      }
    }
  }

  private async collectStats(
    targetPath: string,
    state: GcState,
  ): Promise<ArtifactStats> {
    let files = 0;
    let bytes = 0;
    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(targetPath, { withFileTypes: true });
    } catch (error) {
      recordFailure(state, targetPath, error);
      return { files, bytes };
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childPath = path.join(targetPath, entry.name);
      try {
        const stats = await this.fs.lstat(childPath);
        if (entry.isDirectory()) {
          const childStats = await this.collectStats(childPath, state);
          files += childStats.files;
          bytes += childStats.bytes;
        } else if (stats.isFile()) {
          files += 1;
          bytes += stats.size;
        }
      } catch (error) {
        recordFailure(state, childPath, error);
      }
    }
    return { files, bytes };
  }
}

function artifactLimitReached(state: GcState): boolean {
  return state.deletedArtifacts + state.wouldDeleteArtifacts >= state.limit;
}

function recordFailure(
  state: GcState,
  artifactPath: string,
  error: unknown,
): void {
  state.failures.push({
    path: artifactPath,
    errorMessage: errorMessage(error),
  });
}
