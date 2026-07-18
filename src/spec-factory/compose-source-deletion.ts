import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComposeSourceDeletionPurgeCandidate } from "./compose-database.js";

export interface ComposeSourceDeletionPurgeRepository {
  claimNextSourceDeletionPurge(): Promise<ComposeSourceDeletionPurgeCandidate | null>;
  markSourceDeletionPurged(input: {
    deletionId: number;
    deletedFileCount: number;
    deletedObjectCount: number;
  }): Promise<boolean>;
  markSourceDeletionPurgeFailed(input: {
    deletionId: number;
    errorMessage: string;
  }): Promise<void>;
}

export interface ComposeSourceDeletionObjectStore {
  deleteKeys(keys: string[]): Promise<number>;
  deleteArtifactUris(artifactUris: string[]): Promise<number>;
}

interface FileSystemLike {
  rm(
    targetPath: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
}

export interface ComposeSourceDeletionCleanupResult {
  inspected: number;
  purged: number;
  failed: number;
  deletedFiles: number;
  deletedObjects: number;
  failures: Array<{ deletionId: number; errorMessage: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("source deletion purge limit must be positive");
  }
  return Math.floor(value);
}

function safeWorkspaceRoot(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  const root = path.resolve(trimmed);
  if (!trimmed || !path.isAbsolute(trimmed) || root === path.parse(root).root) {
    throw new Error("source deletion purge requires a safe workspace path");
  }
  return root;
}

function containedFilePath(workspaceRoot: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  const relative = path.relative(workspaceRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `source deletion purge rejected path outside workspace: ${candidate}`,
    );
  }
  return resolved;
}

function localArtifactPath(
  workspaceRoot: string,
  artifact: string,
  allowRelative = false,
): string | null {
  const value = artifact.trim();
  if (!value) return null;
  if (value.startsWith("file://")) {
    const url = new URL(value);
    url.hash = "";
    return containedFilePath(workspaceRoot, fileURLToPath(url));
  }
  if (path.isAbsolute(value)) {
    return containedFilePath(workspaceRoot, value.split("#", 1)[0]);
  }
  if (allowRelative && !value.includes("://")) {
    return containedFilePath(
      workspaceRoot,
      path.resolve(workspaceRoot, value.split("#", 1)[0]),
    );
  }
  return null;
}

export class ComposeSourceDeletionCleaner {
  constructor(
    private readonly repository: ComposeSourceDeletionPurgeRepository,
    private readonly objectStore: ComposeSourceDeletionObjectStore,
    private readonly fs: FileSystemLike = { rm },
  ) {}

  async cleanupExpiredSourceDeletions(
    input: {
      limit?: number;
    } = {},
  ): Promise<ComposeSourceDeletionCleanupResult> {
    const limit = positiveLimit(input.limit);
    const result: ComposeSourceDeletionCleanupResult = {
      inspected: 0,
      purged: 0,
      failed: 0,
      deletedFiles: 0,
      deletedObjects: 0,
      failures: [],
    };

    for (let index = 0; index < limit; index += 1) {
      const candidate = await this.repository.claimNextSourceDeletionPurge();
      if (!candidate) break;
      result.inspected += 1;
      try {
        const workspaceRoot = safeWorkspaceRoot(candidate.workspacePath);
        const localPaths = new Set<string>();
        const s3ArtifactUris: string[] = [];
        for (const candidatePath of candidate.localPaths) {
          if (candidatePath.startsWith("s3://")) {
            s3ArtifactUris.push(candidatePath);
            continue;
          }
          const localPath = localArtifactPath(
            workspaceRoot,
            candidatePath,
            true,
          );
          if (!localPath) {
            throw new Error(
              `source deletion purge rejected unsupported artifact URI: ${candidatePath}`,
            );
          }
          localPaths.add(localPath);
        }
        for (const artifactUri of candidate.artifactUris) {
          if (artifactUri.startsWith("s3://")) {
            s3ArtifactUris.push(artifactUri);
            continue;
          }
          const localPath = localArtifactPath(workspaceRoot, artifactUri);
          if (!localPath) {
            throw new Error(
              `source deletion purge rejected unsupported artifact URI: ${artifactUri}`,
            );
          }
          localPaths.add(localPath);
        }

        let deletedFiles = 0;
        for (const localPath of localPaths) {
          await this.fs.rm(localPath, { recursive: false, force: true });
          deletedFiles += 1;
        }
        const deletedObjects =
          (await this.objectStore.deleteKeys(candidate.s3Keys)) +
          (await this.objectStore.deleteArtifactUris([
            ...new Set(s3ArtifactUris),
          ]));
        const committed = await this.repository.markSourceDeletionPurged({
          deletionId: candidate.deletionId,
          deletedFileCount: deletedFiles,
          deletedObjectCount: deletedObjects,
        });
        if (!committed) {
          throw new Error("source deletion purge lease was lost");
        }
        result.purged += 1;
        result.deletedFiles += deletedFiles;
        result.deletedObjects += deletedObjects;
      } catch (error) {
        const message = errorMessage(error);
        result.failed += 1;
        result.failures.push({
          deletionId: candidate.deletionId,
          errorMessage: message,
        });
        await this.repository.markSourceDeletionPurgeFailed({
          deletionId: candidate.deletionId,
          errorMessage: message,
        });
      }
    }
    return result;
  }
}
